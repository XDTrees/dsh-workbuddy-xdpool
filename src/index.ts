/**
 * Host-side plugin entry. Registers the `workbuddy-xdpool` provider into the
 * Harness LLM seam once the loopback shim holds its port, plus the HTTP status
 * routes consumed by the CLI.
 *
 * @module dsh-workbuddy-xdpool/index
 */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WorkBuddyAccountPool } from './accounts.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import {
  POOL_NAME_BY_REGION,
  POOL_PROVIDER_BY_REGION,
  WORKBUDDY_GLOBAL_POOL_PROVIDER,
  WORKBUDDY_POOL_PROVIDER,
  createWorkBuddyAdapter,
  type WorkBuddyAdapter,
} from './adapter.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
import { buildStatus } from './status.ts'
import { regionOf, WorkBuddyUpstreamClient, type WorkBuddyRegion } from './upstream.ts'
import { registerPoolStatusRoute } from './web-status.ts'

export { WORKBUDDY_POOL_PROVIDER, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  WorkBuddyAccountPool,
  candidateAuthDirs,
  defaultDesktopAuthDirs,
  parseWorkBuddyAuth,
  workbuddyAccountId,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME,
  type WorkBuddyAccount,
  type WorkBuddyCredential,
} from './accounts.ts'
export { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS, type WorkBuddyModelInfo } from './catalog.ts'
export { WorkBuddyUpstreamClient, classifyUpstreamError, parseRateLimitReset, type UpstreamErrorKind } from './upstream.ts'
export { buildStatus, formatStatus, formatRates, type WorkBuddyStatus, type AccountStatus } from './status.ts'
export {
  POOL_CHECKIN_PATH,
  POOL_MODELS_SAVE_PATH,
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebCheckin,
  type PoolWebCheckinClaim,
  type PoolWebModel,
  type PoolWebModelSelection,
  type PoolWebStatus,
} from './status-paths.ts'
export type { ModelSelection } from './catalog.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy-xdpool'

/** The model registry required before the provider can register. */
export const inject = ['llm', 'settings']

/**
 * Settings namespace for the WorkBuddy XD Pool card. Registering a section here
 * is what makes the provider appear on the Models settings page and causes the
 * Host to mount the plugin's client card under Plugin configuration — exactly
 * the mechanism the single-account connector uses.
 */
export const WORKBUDDY_POOL_SETTINGS_NS = 'workbuddy-xdpool' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path override. */
  authFile?: string
  /** Rate-limit cooldown per account, milliseconds. */
  cooldownMs?: number
  /**
   * How the pool spreads requests across accounts.
   *
   * `priority` (default) drains one account before moving to the next, which
   * is what a pool of your own accounts is for. `round-robin` splits the
   * spend evenly instead. Absent reads as `priority`.
   */
  distribution?: 'priority' | 'round-robin'
  /**
   * Model ids enabled in the picker. Absent means "every model the catalog
   * advertises" — an unconfigured install should never present an empty model
   * list just because the key is missing.
   */
  enabledModelIds?: string[]
  /**
   * Model ids that additionally accept image input. Absent means "follow the
   * upstream capability flag"; an explicit list is authoritative for the models
   * it mentions and leaves the rest to the catalog.
   */
  imageModelIds?: string[]
  /**
   * Per-model context-window override, keyed by model id. The upstream can
   * advertise more than DSH wants to hand a single turn, so the card lets the
   * user cap a model without touching the catalog.
   */
  contextBudgets?: Record<string, number>
  /**
   * Per-region model selection. The two gateways advertise different rosters, so
   * one shared list would let a save on one tab silently rewrite the other tab's
   * picker. Each region owns its own copy; a region with no entry falls back to
   * the legacy flat keys above, so an upgrade keeps the list already in use.
   */
  modelSelectionCn?: ModelSelectionConfig
  modelSelectionGlobal?: ModelSelectionConfig
}

/** One region's saved model selection. */
export interface ModelSelectionConfig {
  enabledModelIds?: string[]
  imageModelIds?: string[]
  contextBudgets?: Record<string, number>
}

/** Upper bound the card offers as the "default" context window, in tokens. */
export const DEFAULT_CONTEXT_BUDGET = 200_000

/**
 * One region's model-selection schema.
 *
 * Every field is optional on purpose: an absent field keeps its documented
 * meaning ("all enabled" / "follow the upstream image flag" / "no cap"), and a
 * region that has never been saved stays absent so `applyConfigFromSource` can
 * fall back to the legacy flat keys.
 */
const modelSelectionSchema = z.object({
  enabledModelIds: z.array(z.string()).description('Model ids enabled in this region\'s picker (absent = all)'),
  imageModelIds: z.array(z.string()).description('Model ids accepting image input in this region (absent = follow upstream)'),
  contextBudgets: z.dict(z.number().step(1).min(1)).description('Per-model context-window override for this region'),
})

/** Settings key holding one region's saved selection. */
export const modelSelectionKeyFor = (region: 'cn' | 'global'): string =>
  region === 'cn' ? 'modelSelectionCn' : 'modelSelectionGlobal'

/**
 * Plugin configuration schema.
 *
 * Mirrors the shape the settings section stores. Every field carries a default
 * so a config that never touched the card still folds cleanly: a field whose
 * schema declares no default is read as absent by the settings fold. That is
 * also why `contextBudgets` is a real dictionary (`z.dict`) - an open object
 * schema reads as "an object with no fields" and the fold then throws while
 * the provider row is rendered.
 */
export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app own location)'),
  cooldownMs: z.number().step(1).min(1000).default(60000).description('Rate-limit cooldown per account, in milliseconds'),
  distribution: z.union(['priority', 'round-robin']).default('priority').description('How requests are spread: priority (drain one) or round-robin'),
  enabledModelIds: z.array(z.string()).default([]).description('Legacy shared model-id list; used by a region that has no per-region selection yet'),
  imageModelIds: z.array(z.string()).default([]).description('Legacy shared image-id list; used by a region that has no per-region selection yet'),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description('Legacy shared context budgets; used by a region with no per-region selection yet'),
  modelSelectionCn: modelSelectionSchema.description('Model selection for the domestic gateway'),
  modelSelectionGlobal: modelSelectionSchema.description('Model selection for the international gateway'),
})

/** Everything the CLI needs from a live plugin instance. */
export interface WorkBuddyPoolApi {
  pool: WorkBuddyAccountPool
  /** One catalog per region, matching the two registered providers. */
  catalogs: Readonly<Record<WorkBuddyRegion, WorkBuddyCatalog>>
  client: WorkBuddyUpstreamClient
  shim: WorkBuddyShim
  adapter: WorkBuddyAdapter | undefined
  rescan(): Promise<number>
  status(includeCredits?: boolean): Promise<Awaited<ReturnType<typeof buildStatus>>>
  resetCooldowns(): void
}

/** Live API, published for the CLI. */
let api: WorkBuddyPoolApi | undefined

/** The live API, or undefined when the plugin has not applied yet. */
export function currentApi(): WorkBuddyPoolApi | undefined {
  return api
}

/** Test seam: install an API instance without booting cordis. */
export function setApi(next: WorkBuddyPoolApi | undefined): void {
  api = next
}

/** Assemble the runtime objects without registering anything. */
/**
 * Assemble the runtime objects without registering anything.
 *
 * One catalog per region, mirroring the two shims: the CN and global gateways
 * do not advertise the same roster, and a shared catalog meant the picker showed
 * whichever list happened to be fetched first (always the CN one, since the
 * seeding step read `accounts[0]`).
 */
export function createCore(logger?: { warn(...args: unknown[]): void }) {
  const client = new WorkBuddyUpstreamClient()
  const pool = new WorkBuddyAccountPool({ ...logger === undefined ? {} : { logger }, client })
  const catalogs = {
    cn: new WorkBuddyCatalog(),
    global: new WorkBuddyCatalog(),
  } as const
  return { pool, catalogs, client }
}

/**
 * Start the loopback endpoint, register the `workbuddy-xdpool` provider, and
 * discover accounts. The provider registers only after `shim.ready` resolves,
 * because its models read the shim origin at construction time.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const core = createCore(ctx.logger)

  /**
   * Invalidate the provider snapshot so the picker re-reads the catalog.
   *
   * Seeded with a no-op and reassigned once the adapters exist. The settings
   * section calls its `onChange` hook SYNCHRONOUSLY from `installSection`,
   * before registration has run, so a plain `let builtAdapter` declared later
   * would be read from its temporal dead zone ("Cannot access `builtAdapter`
   * before initialization") and abort the whole apply — which in turn leaves the
   * providers undeclared and the settings page unable to render them.
   */
  /** The domestic adapter, published for the CLI after registration. */
  let builtAdapter: WorkBuddyAdapter | undefined

  let invalidateCatalog = (): void => {}

  // Effective config: the plugin config, then the settings-scope value once
  // the WorkBuddy XD Pool settings section joins (so edits made on the card's
  // Models settings page stay authoritative). A dedicated section is also what
  // tells the Host to mount the plugin's client card under Plugin config.
  let current: () => Config = () => config
  const sectionHooks = {
    setSource(source: () => Config) { current = source },
    onChange() { applyConfigFromSource() },
  }
  const applyConfigFromSource = (): void => {
    const { authFile, cooldownMs, distribution, enabledModelIds, imageModelIds, contextBudgets, modelSelectionCn, modelSelectionGlobal } = current()
    core.pool.applyConfig({
      ...authFile === undefined
        ? {}
        : { authDirs: [dirname(authFile)] },
      ...cooldownMs === undefined ? {} : { cooldownMs },
      // Absent reads as priority, so an install that never opened the card
      // drains one account at a time rather than splitting the spend.
      distribution: distribution ?? 'priority',
    })
    // The model selection travels the same settings path as the pool options:
    // the card writes it through the settings section and each catalog filters
    // its own picker from it. Invalidating the adapter here is what makes a save
    // take effect without a host restart.
    //
    // Every region reads its OWN key. A region that has never been saved falls
    // back to the legacy flat keys, so an upgrade keeps the list the user was
    // already using instead of resetting one side to "everything".
    const legacySelection = {
      ...enabledModelIds === undefined ? {} : { enabledModelIds },
      ...imageModelIds === undefined ? {} : { imageModelIds },
      ...contextBudgets === undefined ? {} : { contextBudgets },
    }
    core.catalogs.cn.applySelection(modelSelectionCn ?? legacySelection)
    core.catalogs.global.applySelection(modelSelectionGlobal ?? legacySelection)
  }
  // `settings` is declared in this plugin top-level `inject`, so the service is
  // available synchronously here. Calling `installSection` without that
  // declaration leaves the host with no settings view for this namespace, and its
  // provider list then reads `undefined` while rendering: the
  // "Cannot read properties of undefined (reading get)" failure.
  const settingsService = ctx.settings as unknown as {
    installSection?: (
      owner: Context,
      ns: SettingsNamespace,
      schema: typeof Config,
      entry: Config,
      hooks: typeof sectionHooks,
    ) => void
    set?: (key: string, value: unknown) => Promise<void> | void
  }
  if (typeof settingsService.installSection === 'function') {
    settingsService.installSection(ctx, WORKBUDDY_POOL_SETTINGS_NS, Config, config, sectionHooks)
  } else {
    ctx.logger.warn?.('dsh-workbuddy-xdpool: settings service has no installSection; card will not mount')
  }

  /**
   * Write one key of the plugin's own settings section. Only ever called with
   * the three model-selection keys, so the settings file cannot be steered from
   * the browser; the catalog re-reads through `onChange` either way.
   */
  const setSetting = (key: string, value: unknown): void => {
    if (value === undefined) return
    const write = settingsService?.set
    if (write === undefined) return
    try {
      void write.call(settingsService, key, value)
    } catch (error: unknown) {
      ctx.logger.warn?.(`dsh-workbuddy-xdpool: failed to persist ${key}`, error)
    }
  }

  // One shim per region. Each carries its own ephemeral port and secret, and
  // each is scoped to its gateway's accounts, so the two providers are fully
  // independent: a failing region cannot take the other one down with it.
  const shims = {
    cn: createWorkBuddyShim({ pool: core.pool, client: core.client, catalog: core.catalogs.cn, logger: ctx.logger, region: 'cn' }),
    global: createWorkBuddyShim({ pool: core.pool, client: core.client, catalog: core.catalogs.global, logger: ctx.logger, region: 'global' }),
  } as const
  const shim = shims.cn

  /** Resolve a region's loopback origin once it has bound a port. */
  const shimInfo = (which: 'cn' | 'global'): { running: boolean; baseUrl?: string } => {
    try {
      const baseUrl = shims[which].baseUrl()
      return { running: true, baseUrl }
    } catch {
      return { running: false }
    }
  }

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shims.cn.close()
    void shims.global.close()
  })

  // Same-origin routes backing the WorkBuddy XD Pool settings card. `webServer`
  // is an optional service: on a headless profile without it, no card routes
  // mount and the card shows an offline banner — the provider still works.
  ctx.inject(['webServer'], (webCtx) => registerPoolStatusRoute(webCtx, {
    pool: core.pool,
    catalogs: core.catalogs,
    client: core.client,
    shim: () => shimInfo('cn'),
    // The settings section owns the model selection; this is the write half of
    // the card's save round-trip. It goes through `settingsScope.set` (below)
    // so the change lands in the same document the model picker reads.
    //
    // The region is written to its own key: saving the domestic tab must never
    // rewrite the international picker, because the two gateways advertise
    // different rosters and the user curates them separately.
    saveSelection: (region, selection) => {
      setSetting(modelSelectionKeyFor(region), {
        ...selection.enabledModelIds === undefined ? {} : { enabledModelIds: [...selection.enabledModelIds] },
        ...selection.imageModelIds === undefined ? {} : { imageModelIds: [...selection.imageModelIds] },
        ...selection.contextBudgets === undefined ? {} : { contextBudgets: { ...selection.contextBudgets } },
      })
    },
  }))
  api = {
    ...core,
    shim,
    get adapter() { return builtAdapter },
    async rescan() {
      const accounts = await core.pool.scan()
      ctx.logger.info?.(`dsh-workbuddy-xdpool: discovered ${accounts.length} account(s)`)
      return accounts.length
    },
    async status(includeCredits = false) {
      return buildStatus({
        pool: core.pool,
        catalog: core.catalogs.cn,
        client: core.client,
        shim: shimInfo('cn'),
        includeCredits,
      })
    },
    resetCooldowns() {
      core.pool.resetCooldowns()
    },
  }

  // Register once BOTH loopback listeners hold a port: each adapter reads its
  // shim origin at construction time, so neither can be built any earlier.
  void Promise.all([shims.cn.ready, shims.global.ready])
    .then(async () => {
      if (stopped) return

      try {
        // One adapter per region. Each provider is bound to its own account
        // slice of the pool (see the `region` argument on `pool.acquire`), so a
        // CN request can never be served by a global account and vice versa —
        // the two gateways are not interchangeable.
        const adaptersByRegion = {
          cn: createWorkBuddyAdapter({
            ctx,
            shim: shims.cn,
            catalog: core.catalogs.cn,
            providerId: POOL_PROVIDER_BY_REGION.cn,
            displayName: POOL_NAME_BY_REGION.cn,
          }),
          global: createWorkBuddyAdapter({
            ctx,
            shim: shims.global,
            catalog: core.catalogs.global,
            providerId: POOL_PROVIDER_BY_REGION.global,
            displayName: POOL_NAME_BY_REGION.global,
          }),
        } as const

        let releaseAdapterCn: (() => void) | undefined
        let releaseAdapterGlobal: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapterCn = ctx.llm.registerAdapter(
            [POOL_PROVIDER_BY_REGION.cn],
            adaptersByRegion.cn.adapter,
          )
          releaseAdapterGlobal = ctx.llm.registerAdapter(
            [POOL_PROVIDER_BY_REGION.global],
            adaptersByRegion.global.adapter,
          )
          // Both entries go in ONE call: the host mounts a single configuration
          // form for the pair, sharing the plugin settings section. Registering
          // them one at a time left the second call reading a registry entry the
          // first had not finished creating (the `reading 'get'` failure).
          releaseDirectory = ctx.llm.registerConfigurableProviders([
            {
              provider: POOL_PROVIDER_BY_REGION.cn,
              displayName: POOL_NAME_BY_REGION.cn,
              settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            },
            {
              provider: POOL_PROVIDER_BY_REGION.global,
              displayName: POOL_NAME_BY_REGION.global,
              settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            },
          ])
        } finally {
          // A throw part-way through leaves the earlier registrations live; undo
          // them so a failed startup does not leave half a provider behind.
          if (releaseAdapterCn === undefined || releaseAdapterGlobal === undefined || releaseDirectory === undefined) {
            releaseAdapterCn?.()
            releaseAdapterGlobal?.()
            releaseDirectory?.()
          }
        }

        builtAdapter = adaptersByRegion.cn
        // From here on a settings change can rebuild the picker. Until this line
        // runs, `invalidateCatalog` is the no-op seeded at the top of apply.
        invalidateCatalog = () => {
          adaptersByRegion.cn.invalidate()
          adaptersByRegion.global.invalidate()
        }

        /** Release everything the two providers registered, once. */
        const releaseProviders = (): void => {
          releaseAdapterCn?.()
          releaseAdapterGlobal?.()
          releaseDirectory?.()
        }
        try {
          ctx.effect(() => releaseProviders)
        } catch {
          // The plugin was disposed while registering; release immediately.
          releaseProviders()
        }

        // The model picker asks the host for a provider's catalog; answering
        // here (rather than only from the adapter's static snapshot) is what
        // makes a saved selection visible without a restart. Each region answers
        // from its own catalog — the two gateways do not advertise the same
        // roster, so one shared list would serve the wrong models to one of them.
        ctx.llm.registerModelDiscovery(WORKBUDDY_POOL_SETTINGS_NS, async (request: { provider?: string }) => {
          if (request.provider !== WORKBUDDY_POOL_PROVIDER
            && request.provider !== WORKBUDDY_GLOBAL_POOL_PROVIDER) return []
          const region = request.provider === WORKBUDDY_GLOBAL_POOL_PROVIDER ? 'global' : 'cn'
          return core.catalogs[region].visible().map(model => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutputTokens,
            inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
          }))
        })

        ctx.logger.info?.(
          `dsh-workbuddy-xdpool: providers registered at cn=${shims.cn.baseUrl()} global=${shims.global.baseUrl()}`,
        )
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy-xdpool: provider registration failed', error)
        return
      }

      // Discover accounts; the fallback catalog already serves models meanwhile.
      if (stopped) return
      void core.pool.scan().then(
        accounts => {
          ctx.logger.info?.(`dsh-workbuddy-xdpool: ${accounts.length} WorkBuddy account(s) in rotation`)
        },
        (error: unknown) => {
          ctx.logger.warn('dsh-workbuddy-xdpool: account discovery failed', error)
        },
      )

      // Seed the live model catalog (with per-model credit multipliers and
      // reasoning levels) from the upstream; the static fallback covers an
      // offline upstream so the provider is never empty.
      void (async () => {
        // Seed each region from its OWN account and endpoint: the two gateways
        // advertise different rosters, so seeding both from accounts[0] gave the
        // global provider the CN model list (and vice versa). A region with no
        // signed-in account keeps its static fallback.
        const accounts = await core.pool.scan()
        for (const region of ['cn', 'global'] as const) {
          try {
            const credential = accounts.find(account => regionOf(account.credential.domain) === region)?.credential
            if (credential === undefined) {
              ctx.logger.info?.(`dsh-workbuddy-xdpool: no ${region} account yet; keeping the static ${region} catalog`)
              continue
            }
            const models = await core.client.fetchModels(credential)
            core.catalogs[region].updateFromUpstream(models)
            ctx.logger.info?.(`dsh-workbuddy-xdpool: ${region} catalog seeded with ${models.length} model(s)`)
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-workbuddy-xdpool: ${region} model catalog unavailable; using static fallback`, error)
          }
        }
        invalidateCatalog()
      })()
    }, (error: unknown) => {
      ctx.logger.error('dsh-workbuddy-xdpool: shim failed to listen', error)
    })
}

void ({} as unknown as Context | undefined)
export type { Context }
