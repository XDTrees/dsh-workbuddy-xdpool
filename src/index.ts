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
import { WORKBUDDY_POOL_PROVIDER, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
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
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebCheckin,
  type PoolWebCheckinClaim,
  type PoolWebStatus,
} from './status-paths.ts'

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
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  cooldownMs: z.number().step(1).min(1000).description('Rate-limit cooldown per account, in milliseconds'),
})

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
    const { authFile, cooldownMs } = current()
    core.pool.applyConfig({
      ...authFile === undefined
        ? {}
        : { authDirs: [dirname(authFile)] },
      ...cooldownMs === undefined ? {} : { cooldownMs },
    })
  }
  // The settings service is reached through inject() — cordis refuses bare
  // property reads outside a declared dependency. DSH 0.1.2-rc.1 exposes the
  // section installer on the settings service itself (`installSection`); the
  // older free function no longer ships on this core.
  ctx.inject(['settings'], settingsCtx => {
    const service = settingsCtx.settings as unknown as {
      installSection?: (
        owner: Context,
        ns: SettingsNamespace,
        schema: typeof Config,
        entry: Config,
        hooks: typeof sectionHooks,
      ) => void
    }
    if (typeof service.installSection === 'function') {
      service.installSection(ctx, WORKBUDDY_POOL_SETTINGS_NS, Config, config, sectionHooks)
    } else {
      ctx.logger.warn?.('dsh-workbuddy-xdpool: settings service has no installSection; card will not mount')
    }
  })

  const shim = createWorkBuddyShim({
    pool: core.pool,
    client: core.client,
    catalog: core.catalog,
    logger: ctx.logger,
  })

  let stopped = false
  let builtAdapter: WorkBuddyAdapter | undefined
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
  })

  // Same-origin routes backing the WorkBuddy XD Pool settings card. `webServer`
  // is an optional service: on a headless profile without it, no card routes
  // mount and the card shows an offline banner — the provider still works.
  ctx.inject(['webServer'], (webCtx) => registerPoolStatusRoute(webCtx, {
    pool: core.pool,
    catalog: core.catalog,
    client: core.client,
    shim: () => {
      let baseUrl: string | undefined
      try { baseUrl = shim.baseUrl() } catch { baseUrl = undefined }
      return { running: baseUrl !== undefined, ...baseUrl === undefined ? {} : { baseUrl } }
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
      let baseUrl: string | undefined
      try { baseUrl = shim.baseUrl() } catch { baseUrl = undefined }
      return buildStatus({
        pool: core.pool,
        catalog: core.catalog,
        client: core.client,
        shim: { running: baseUrl !== undefined, ...baseUrl === undefined ? {} : { baseUrl } },
        includeCredits,
      })
    },
    resetCooldowns() {
      core.pool.resetCooldowns()
    },
  }

  void shim.ready
    .then(async () => {
      if (stopped) return

      let releaseAdapter: (() => void) | undefined
      let releaseDirectory: (() => void) | undefined
      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const workbuddy = createWorkBuddyAdapter({ shim, catalog: core.catalog })
        builtAdapter = workbuddy

        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_POOL_PROVIDER], workbuddy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_POOL_PROVIDER,
            displayName: 'WorkBuddy XD Pool',
            settingsNs: WORKBUDDY_POOL_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          releaseAdapter?.()
          releaseDirectory?.()
        }

        ctx.logger.info?.(`dsh-workbuddy-xdpool: provider registered at ${shim.baseUrl()}`)
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