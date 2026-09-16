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
import { WorkBuddyUpstreamClient } from './upstream.ts'
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
export const inject = ['llm']

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
   * Model ids enabled in the picker. Absent means "every model the catalog
   * advertises" — an unconfigured install should never present an empty model
   * list just because the key is missing.
   */
  enabledModelIds?: readonly string[]
  /**
   * Model ids that additionally accept image input. Absent means "follow the
   * upstream capability flag"; an explicit list is authoritative for the models
   * it mentions and leaves the rest to the catalog.
   */
  imageModelIds?: readonly string[]
  /**
   * Per-model context-window override, keyed by model id. The upstream can
   * advertise more than DSH wants to hand a single turn, so the card lets the
   * user cap a model without touching the catalog.
   */
  contextBudgets?: Record<string, number>
}

/** Upper bound the card offers as the "default" context window, in tokens. */
export const DEFAULT_CONTEXT_BUDGET = 200_000

/**
 * Plugin configuration schema.
 *
 * `contextBudgets` uses an open object schema rather than a dictionary
 * helper: the helper infers a cosmokit `Dict` type that the generated .d.ts
 * cannot name without leaking that dependency to consumers.
 */
export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  cooldownMs: z.number().step(1).min(1000).description('Rate-limit cooldown per account, in milliseconds'),
  enabledModelIds: z.array(z.string()).description('Model ids enabled in the picker (absent = all)'),
  imageModelIds: z.array(z.string()).description('Model ids that accept image input (absent = upstream capability)'),
  contextBudgets: z.object({}).description('Per-model context-window override, keyed by model id'),
}) as unknown as z<Config>

/** Everything the CLI needs from a live plugin instance. */
export interface WorkBuddyPoolApi {
  pool: WorkBuddyAccountPool
  catalog: WorkBuddyCatalog
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
export function createCore(logger?: { warn(...args: unknown[]): void }) {
  const client = new WorkBuddyUpstreamClient()
  const pool = new WorkBuddyAccountPool({ ...logger === undefined ? {} : { logger }, client })
  return { pool, catalog: new WorkBuddyCatalog(), client }
}

/**
 * Start the loopback endpoint, register the `workbuddy-xdpool` provider, and
 * discover accounts. The provider registers only after `shim.ready` resolves,
 * because its models read the shim origin at construction time.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const core = createCore(ctx.logger)

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
    const { authFile, cooldownMs, enabledModelIds, imageModelIds, contextBudgets } = current()
    core.pool.applyConfig({
      ...authFile === undefined
        ? {}
        : { authDirs: [dirname(authFile)] },
      ...cooldownMs === undefined ? {} : { cooldownMs },
    })
    // The model selection travels the same settings path as the pool options:
    // the card writes it through the settings section and the catalog filters
    // the picker from it. Invalidating the adapter here is what makes a save
    // take effect without a host restart.
    core.catalog.applySelection({
      ...enabledModelIds === undefined ? {} : { enabledModelIds },
      ...imageModelIds === undefined ? {} : { imageModelIds },
      ...contextBudgets === undefined ? {} : { contextBudgets },
    })
    builtAdapter?.invalidate()
  }
  // The settings service is reached through inject() — cordis refuses bare
  // property reads outside a declared dependency. DSH 0.1.2-rc.1 exposes the
  // section installer on the settings service itself (`installSection`); the
  // older free function no longer ships on this core.
  // Captured so the card's save route can write the selection back into the
  // same settings document the model picker reads. Absent when the host ships
  // no settings service — the save route then answers 503 instead of silently
  // dropping the write.
  let settingsService: { set?: (key: string, value: unknown) => Promise<void> | void } | undefined
  ctx.inject(['settings'], settingsCtx => {
    const service = settingsCtx.settings as unknown as {
      installSection?: (
        owner: Context,
        ns: SettingsNamespace,
        schema: typeof Config,
        entry: Config,
        hooks: typeof sectionHooks,
      ) => void
      set?: (key: string, value: unknown) => Promise<void> | void
    }
    if (typeof service.installSection === 'function') {
      service.installSection(ctx, WORKBUDDY_POOL_SETTINGS_NS, Config, config, sectionHooks)
    } else {
      ctx.logger.warn?.('dsh-workbuddy-xdpool: settings service has no installSection; card will not mount')
    }
    settingsService = typeof service.set === 'function' ? service : undefined
  })

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
    cn: createWorkBuddyShim({ pool: core.pool, client: core.client, catalog: core.catalog, logger: ctx.logger, region: 'cn' }),
    global: createWorkBuddyShim({ pool: core.pool, client: core.client, catalog: core.catalog, logger: ctx.logger, region: 'global' }),
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
  let builtAdapter: WorkBuddyAdapter | undefined
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
    catalog: core.catalog,
    client: core.client,
    shim: () => shimInfo('cn'),
    // The settings section owns the model selection; this is the write half of
    // the card's save round-trip. It goes through `settingsScope.set` (below)
    // so the change lands in the same document the model picker reads.
    saveSelection: (selection) => {
      setSetting('enabledModelIds', selection.enabledModelIds)
      setSetting('imageModelIds', selection.imageModelIds)
      setSetting('contextBudgets', selection.contextBudgets)
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
        catalog: core.catalog,
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

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        // One adapter per region. Each provider is bound to its own account
        // slice of the pool (see the `region` argument on `pool.acquire`), so a
        // CN request can never be served by a global account and vice versa —
        // the two gateways are not interchangeable.
        const built: WorkBuddyAdapter[] = []
        const releases: (() => void)[] = []
        try {
          for (const region of ['cn', 'global'] as const) {
            const provider = POOL_PROVIDER_BY_REGION[region]
            const adapter = createWorkBuddyAdapter({
              shim: shims[region],
              catalog: core.catalog,
              providerId: provider,
              displayName: POOL_NAME_BY_REGION[region],
            })
            built.push(adapter)
            releases.push(ctx.llm.registerAdapter([provider], adapter.adapter))
            releases.push(ctx.llm.registerConfigurableProviders([{
              provider,
              displayName: POOL_NAME_BY_REGION[region],
              settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
              settingsPath: [],
              declared: false,
            }]))
          }
          builtAdapter = built[0]
        } catch (error: unknown) {
          for (const release of releases) release()
          throw error
        }

        try {
          ctx.effect(() => () => {
            for (const release of releases) release()
          })
        } catch {
          for (const release of releases) release()
        }

        // The model picker asks the host for a provider's catalog; answering
        // here (rather than only from the adapter's static snapshot) is what
        // makes a saved selection visible without a restart. Both regions share
        // one catalog: the upstream advertises the same models on each gateway,
        // and the selection is a property of the pool rather than of a region.
        ctx.llm.registerModelDiscovery(WORKBUDDY_POOL_SETTINGS_NS, async (request: { provider?: string }) => {
          if (request.provider !== WORKBUDDY_POOL_PROVIDER
            && request.provider !== WORKBUDDY_GLOBAL_POOL_PROVIDER) return []
          return core.catalog.visible().map(model => ({
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
        try {
          const accounts = await core.pool.scan()
          const credential = accounts[0]?.credential
          if (credential === undefined) return
          const models = await core.client.fetchModels(credential)
          core.catalog.updateFromUpstream(models)
          builtAdapter?.invalidate()
          ctx.logger.info?.(`dsh-workbuddy-xdpool: live catalog seeded with ${models.length} model(s)`)
        } catch (error: unknown) {
          ctx.logger.warn('dsh-workbuddy-xdpool: live model catalog unavailable; using static fallback', error)
        }
      })()
    }, (error: unknown) => {
      ctx.logger.error('dsh-workbuddy-xdpool: shim failed to listen', error)
    })
}

void ({} as unknown as Context | undefined)
export type { Context }
