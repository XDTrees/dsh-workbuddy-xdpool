/**
 * The `workbuddy-xdpool` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
 * points. Every model points at the shim; account rotation stays inside it.
 *
 * Assembly (createProvider + openAICompletionsApi + inert auth plane + the
 * shim's in-process secret as apiKey) follows corrinehu/dsh-workbuddy-connect
 * (MIT, Copyright (c) 2026 Corrine Hu) and dingminhua/dsh-connect-workbuddy
 * (MIT), both designed and validated against this host.
 *
 * @module dsh-workbuddy-xdpool/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyShim } from './shim.ts'

/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
export const WORKBUDDY_POOL_PROVIDER = 'workbuddy-xdpool'
/** Provider route this bundle owns for the international gateway. */
export const WORKBUDDY_GLOBAL_POOL_PROVIDER = 'workbuddy-xdpool-global'
/** The provider id each region registers as. */
export const POOL_PROVIDER_BY_REGION = {
  cn: WORKBUDDY_POOL_PROVIDER,
  global: WORKBUDDY_GLOBAL_POOL_PROVIDER,
} as const
/** Display name each region registers under, so the picker can group them. */
export const POOL_NAME_BY_REGION = {
  cn: 'WorkBuddy XD Pool（国内版）',
  global: 'WorkBuddy XD Pool（国际版）',
} as const

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The route authenticates only through the shim shared
 * secret resolved per request, so pi-ai's own credential lifecycle must never
 * manufacture a credential for it.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy-xdpool: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  catalog: WorkBuddyCatalog
  providerId?: string
  displayName?: string
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  providerId: string
  displayName: string
  adapter: PiAiAdapter
  /** Rebuild the pi-ai model list from the current catalog. */
  buildModels: () => Model<Api>[]
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/** pi-ai input modalities: images only when the catalog advertises them. */
function modelInput(info: WorkBuddyModelInfo): ('text' | 'image')[] {
  return info.supportsImages ? ['text', 'image'] : ['text']
}

/** Map only levels the catalog advertises; undeclared DSH levels stay off. */
function thinkingLevelMap(info: WorkBuddyModelInfo): Record<string, string | null> | undefined {
  const efforts = info.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return undefined
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const map: Record<string, string | null> = {}
  for (const level of levels) map[level] = (efforts as readonly string[]).includes(level) ? level : null
  map['off'] = null
  return map
}

/** Middle-dot separator: unambiguous between the model's own hyphens and the
 *  rate/badge suffix. Matches the LaoDing family convention. */
const DISPLAY_SEPARATOR = ' · '

/** Map an upstream tag code to the localized promo label shown next to the
 *  credit rate in the model picker. Both `free` and `limited-free` collapse to
 *  the same short label so the dropdown row stays scannable. */
const TAG_LABEL: Readonly<Record<string, string>> = {
  'free': '限时免费',
  'limited-free': '限时免费',
  'night-discount': '夜间折扣',
}

/** Resolve the display suffix (`xN.NN`, promo badges) for one catalog row.
 *  Returns `undefined` when there's nothing to show — the name is left alone
 *  so we don't tack a trailing separator on a plain model. */
function displaySuffix(info: WorkBuddyModelInfo): string | undefined {
  const parts: string[] = []
  if (typeof info.multiplier === 'number' && Number.isFinite(info.multiplier)) {
    parts.push(`x${info.multiplier.toFixed(2)}`)
  }
  for (const tag of info.tags ?? []) {
    const label = TAG_LABEL[tag]
    if (label !== undefined && !parts.includes(label)) parts.push(label)
  }
  return parts.length === 0 ? undefined : parts.join(DISPLAY_SEPARATOR)
}

/** Apply the catalog's rate + promo badges to one model's display name.
 *  Display-only: the wire request is built from `model.id`, so renaming here
 *  cannot affect routing, token, or upstream accounting. DSH 0.1.2's composer
 *  (`ModelSelect`) renders `model.name` only, which is why the rate and
 *  badges ride the name rather than a separate description column. */
function withCatalogDisplay(name: string, info: WorkBuddyModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string, providerId: string): Model<Api> {
  const map = thinkingLevelMap(info)
  return {
    id: info.id,
    name: withCatalogDisplay(info.name, info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: modelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
    reasoning: map !== undefined,
    ...map === undefined ? {} : { thinkingLevelMap: map },
    compat: { supportsReasoningEffort: map !== undefined },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. `getModels` re-reads the live catalog, and every
 * model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup. Call only after `shim.ready`.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, catalog } = options
  const providerId = options.providerId ?? WORKBUDDY_POOL_PROVIDER
  const displayName = options.displayName ?? 'WorkBuddy XD Pool'

  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.visible().map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy XD Pool loopback secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy XD Pool' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-xdpool retryPolicy'),
    configuredMaxTokens: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The shim's per-process secret is the OpenAI apiKey; the shim validates it
    // and resolves the real WorkBuddy token itself, per request, from the pool.
    resolveApiKey: async () => shim.token(),
  })

  return {
    providerId,
    displayName,
    adapter,
    buildModels,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}
