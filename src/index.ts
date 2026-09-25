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
import { WorkBuddyScheduler, type AutomationJobKind, type AutomationLedger, type AutomationOptions } from './scheduler.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
import { buildStatus } from './status.ts'
export {
  AUTOMATION_JOB_KINDS, AUTOMATION_TICK_MS, EVENT_SCORE_WAIT_MS, WorkBuddyScheduler, dayKey,
  isAutomationJobKind, isFireHour,
  type AutomationLedger, type AutomationRunSummary, type AutomationStatus, type SchedulerLogger,
} from './scheduler.ts'
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
export { WorkBuddyUpstreamClient, buddyAppEvents, classifyUpstreamError, desktopAutomationCreatedEvent, desktopCanvasEvents, desktopChatEvents, parseRateLimitReset, type UpstreamErrorKind } from './upstream.ts'
export {
  APPEARANCE_THEME_KEY, BUDDY_APP_ID, BUDDY_APP_NAME, LIBRARY_DOC_URL, LIGHTHOUSE_EXPERT_ID,
  PLAYBOOK_CASE_ID, PLAYBOOK_CASE_NAME, SKILL_ID, SKILL_NAME, TEMPLATE_PRESETS,
  appearanceChain, automationChain, buddyAppChain, canvasChain, chatChain, expertActualUseEvent,
  expertChatEvents, expertSummonEvents, libraryReadChain, playbookChain, skillChain, templateChain,
  templateChains,
  type ExpertUseMode, type MarketExpert, type TaskEventChain, type TaskEventTransport,
} from './task-events.ts'
export { buildStatus, formatStatus, formatRates, type WorkBuddyStatus, type AccountStatus } from './status.ts'
export {
  POOL_AUTOMATION_RUN_PATH,
  POOL_CREDIT_RESERVE_PATH,
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

// The card half talks to these routes over HTTP; exporting the registrar and
// its option shape lets a probe mount the real table instead of trusting that
// a registration landed outside the teardown closure.
export { poolWebStatus, registerPoolStatusRoute, type PoolStatusRouteOptions } from './web-status.ts'

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
   * - `priority` (default) drains one account before moving to the next, which
   *   is what a pool of your own accounts is for.
   * - `round-robin` walks the pool in order, so the spend splits evenly.
   * - `balanced` draws at random, weighting whichever account has been idle
   *   longest. Spend still spreads, but without a fixed order, so one unhealthy
   *   account cannot pin the pool to itself.
   *
   * Absent reads as `priority`.
   */
  distribution?: 'priority' | 'round-robin' | 'balanced'
  /**
   * Account ids switched off on the card. A disabled account is never picked
   * to serve a request, but it stays in the pool and on the card so it can be
   * switched back on. Ids are the pool's stable per-credential keys, which
   * survive re-scans (see WorkBuddyAccountPool.disabledIds).
   */
  disabledAccountIds?: string[]
  /**
   * Per-account credit floor, keyed by account id. The pool stops picking an
   * account once its last known balance reaches this value, so the reserved
   * credits survive. Absent or 0 spends the account down as before.
   */
  creditReserves?: Record<string, number>
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
  /**
   * Daily-points automation. Absent means off: the scheduler makes upstream
   * calls on the user behalf, so it stays opt-in rather than surprising a
   * fresh install with background traffic.
   */
  automation?: AutomationConfig
  /**
   * The automation's daily earnings ledger, written by the scheduler itself.
   *
   * It lives in settings rather than only in memory so a host restart mid-day
   * does not wipe what the automation already earned.
   */
  automationEarnings?: AutomationLedger
}

/** One region's saved model selection. */
export interface ModelSelectionConfig {
  enabledModelIds?: string[]
  imageModelIds?: string[]
  contextBudgets?: Record<string, number>
}

/**
 * Daily-points automation.
 *
 * Absent means off: the scheduler makes upstream calls on the user behalf, so
 * it stays opt-in rather than surprising a fresh install with background
 * traffic. Each job carries its own hour list so the passes can be spread out
 * (or pushed off-peak) without disabling any of them.
 *
 * Ordering note: the report job must run before the task job. A report is what
 * lights the growth streak and unlocks the `first_buddy` family, so a task pass
 * that ran first would read counters before they could have moved.
 */
export interface AutomationConfig {
  /** Master switch for every automation job. Absent reads as false. */
  enabled?: boolean
  /** Hours (local, 0-23) at which the daily check-in runs. */
  checkinHours?: number[]
  /** Hours at which the activity report runs. Keep ahead of `taskHours`. */
  reportHours?: number[]
  /** Hours at which tasks are enrolled in and claimed. */
  taskHours?: number[]
  /** Hours at which streak redemption runs. */
  streakHours?: number[]
  /** Hours at which the buddy travel loop runs. */
  travelHours?: number[]
  /** How long an account rests after its credits run out, in milliseconds. */
  exhaustCooldownMs?: number
}


/** Upper bound the card offers as the "default" context window, in tokens. */
export const DEFAULT_CONTEXT_BUDGET = 200_000

/**
 * Fold a saved automation block into scheduler options.
 *
 * Absent means off, stated once here so every caller agrees: the card writes
 * `enabled` as a real boolean, and a config that never touched the section must
 * not accidentally arm background upstream traffic.
 */
export function automationOptions(automation: AutomationConfig | undefined): AutomationOptions {
  return {
    enabled: automation?.enabled === true,
    ...automation?.checkinHours === undefined ? {} : { checkinHours: automation.checkinHours },
    ...automation?.reportHours === undefined ? {} : { reportHours: automation.reportHours },
    ...automation?.taskHours === undefined ? {} : { taskHours: automation.taskHours },
    ...automation?.streakHours === undefined ? {} : { streakHours: automation.streakHours },
    ...automation?.travelHours === undefined ? {} : { travelHours: automation.travelHours },
  }
}

/**
 * One region's model-selection schema.
 *
 * Every field is optional on purpose: an absent field keeps its documented
 * meaning ("all enabled" / "follow the upstream image flag" / "no cap"), and a
 * region that has never been saved stays absent so `applyConfigFromSource` can
 * fall back to the legacy flat keys.
 */
function asVolatile<S>(schema: S): S {
  const candidate = schema as unknown as { volatile?: () => S }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/**
 * Peel one live volatile reference.
 *
 * On 0.1.7 a volatile field is handed back as `{ get(): T }` rather than a
 * plain value, so a running instance observes a settings edit without being
 * remounted. Every read of a marked field therefore has to unwrap: passing the
 * reference onward compares an object against a string and reports the field as
 * unset. On 0.1.5 the field is already a plain value, so this is a no-op.
 *
 * The test is duck-typed on purpose — importing `isVolatile` would add a
 * dependency the 0.1.5 line does not carry.
 */
function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * Deep copy of a config value with every live `{get(): T}` reference replaced
 * by the value it resolves to.
 *
 * {@link unwrapVolatile} peels only the one level an ordinary read needs. A
 * settings service is different: it validates and `structuredClone`s the WHOLE
 * object, so a reference surviving anywhere inside it fails schema validation
 * with a message that names the field but not the cause —
 * `$.authFile expected string but got [object Object]`. That is what makes the
 * namespace fail to register and the card silently disappear, which is why the
 * object handed to `installSection` goes through this first.
 */
function unwrapVolatileDeep<T>(value: T): T {
  const peeled = unwrapVolatile(value)
  if (Array.isArray(peeled)) return peeled.map(entry => unwrapVolatileDeep(entry)) as T
  if (peeled !== null && typeof peeled === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry)
    return out as T
  }
  return peeled
}

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

/**
 * Automation schema.
 *
 * `enabled` carries a real default (false) because the scheduler reads it on
 * every tick and a missing field must mean "off" rather than "undefined".
 * The hour lists fall back in the scheduler itself, so they stay optional here
 * and an absent list keeps the documented schedule.
 *
 * `exhaustCooldownMs` is mirrored from the pool options: the card offers it as
 * part of the automation block, since how long a spent account rests only
 * matters to the automation that has to work around it.
 */
const automationSchema = z.object({
  enabled: z.boolean().default(false).description('Run the daily points automation'),
  checkinHours: z.array(z.number().step(1).min(0).max(23)).description('Local hours for the daily check-in'),
  reportHours: z.array(z.number().step(1).min(0).max(23)).description('Local hours for the activity report (runs before tasks)'),
  taskHours: z.array(z.number().step(1).min(0).max(23)).description('Local hours for task enrolment and claiming'),
  streakHours: z.array(z.number().step(1).min(0).max(23)).description('Local hours for streak redemption'),
  travelHours: z.array(z.number().step(1).min(0).max(23)).description('Local hours for the buddy travel loop'),
  exhaustCooldownMs: z.number().step(1).min(1000).description('How long a spent account rests, in milliseconds'),
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
 *
 * Every field is wrapped in {@link asVolatile}: on the 0.1.7 line the settings
 * write gate refuses an entry whose schema declares no volatile field at all
 * ("Plugin entry ... has no volatile fields") and `describe()` skips such an
 * entry — so an unmarked schema means the card can neither render nor save. On
 * the 0.1.5 line the wrapper degrades to an identity no-op (see its JSDoc), and
 * the value the running instance reads is a plain value either way once
 * unwrapped.
 */
export const Config: z<Config> = z.object({
  authFile: asVolatile(z.string().description('WorkBuddy desktop auth file (defaults to the app own location)')),
  cooldownMs: asVolatile(z.number().step(1).min(1000).default(60000).description('Rate-limit cooldown per account, in milliseconds')),
  distribution: asVolatile(z.union(['priority', 'round-robin', 'balanced']).default('priority').description('How requests are spread: priority (drain one), round-robin (in order), or balanced (idle-weighted random)')),
  disabledAccountIds: asVolatile(z.array(z.string()).default([]).description('Account ids excluded from the pool (empty = every discovered account participates)')),
  creditReserves: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description('Per-account credit floor: stop using an account once its balance reaches this value')),
  enabledModelIds: asVolatile(z.array(z.string()).default([]).description('Legacy shared model-id list; used by a region that has no per-region selection yet')),
  imageModelIds: asVolatile(z.array(z.string()).default([]).description('Legacy shared image-id list; used by a region that has no per-region selection yet')),
  contextBudgets: asVolatile(z.dict(z.number().step(1).min(1)).default({}).description('Legacy shared context budgets; used by a region with no per-region selection yet')),
  modelSelectionCn: asVolatile(modelSelectionSchema.description('Model selection for the domestic gateway')),
  modelSelectionGlobal: asVolatile(modelSelectionSchema.description('Model selection for the international gateway')),
  automation: asVolatile(automationSchema.description('Daily points automation (activity report, task claiming, check-in)')),
  automationEarnings: asVolatile(z.any().description('Automation earnings ledger (written by the scheduler)'))

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
  /** Daily-points automation; assembled with the core, inert until started. */
  scheduler: WorkBuddyScheduler

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
export function createCore(logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void }) {
  const client = new WorkBuddyUpstreamClient()
  const pool = new WorkBuddyAccountPool({ ...logger === undefined ? {} : { logger }, client })
  const catalogs = {
    cn: new WorkBuddyCatalog(),
    global: new WorkBuddyCatalog(),
  } as const
  // The scheduler is assembled here but stays inert until `start()`: the CLI and
  // the tests both build a core without wanting background traffic.
  const scheduler = new WorkBuddyScheduler(pool, client, { ...logger === undefined ? {} : { logger } })
  return { pool, catalogs, client, scheduler }
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
  /**
   * The effective config with every live volatile reference peeled.
   *
   * On 0.1.7 a field marked volatile is handed to the plugin as `{get(): T}` so
   * a settings edit is observed without a remount, and the loader keeps the
   * reference live. Every read below therefore goes through this view: a raw
   * reference compared against a string reports the field as unset, which is
   * how a saved reserve would read back as "0" while the file holds the value.
   * On 0.1.5 there is nothing to peel and this is the identity.
   */
  let rawCurrent: () => Config = () => config
  const current = (): Config => unwrapVolatileDeep(rawCurrent())
  const sectionHooks = {
    setSource(source: () => Config) { rawCurrent = source },
    onChange() { applyConfigFromSource() },
  }
  const applyConfigFromSource = (): void => {
    const { authFile, cooldownMs, distribution, disabledAccountIds, creditReserves, enabledModelIds, imageModelIds, contextBudgets, modelSelectionCn, modelSelectionGlobal, automation } = current()
    core.pool.applyConfig({
      ...authFile === undefined
        ? {}
        : { authDirs: [dirname(authFile)] },
      ...cooldownMs === undefined ? {} : { cooldownMs },
      // Absent reads as priority, so an install that never opened the card
      // drains one account at a time rather than splitting the spend.
      distribution: distribution ?? 'priority',
      ...disabledAccountIds === undefined ? {} : { disabledAccountIds },
      // Reserves travel with every other pool option, so a save on the card is
      // in force without a host restart.
      ...creditReserves === undefined ? {} : { creditReserves },
      // How long a spent account rests also shapes the automation: the task pass
      // skips a cooling account, so a short window means fewer accounts are
      // excluded when a job runs.
      ...automation?.exhaustCooldownMs === undefined ? {} : { exhaustCooldownMs: automation.exhaustCooldownMs },
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
    // The automation reads the same settings document, so a save on the card
    // re-arms it without a host restart. An absent block means off, which is why
    // this passes `enabled: false` explicitly rather than leaving it undefined.
    core.scheduler.applyConfig(automationOptions(automation))
  }
  // ---------------------------------------------------------------------
  // Settings registration, on whichever host line is running.
  //
  // The two lines do not share a settings API:
  //
  //   0.1.5  SettingsProvider.installSection(owner, ns, schema, entry, hooks)
  //          registers a NAMESPACE the plugin picks, and pushes changes back
  //          through the `hooks.onChange` callback.
  //   0.1.7  SettingsForms.configure({auto}, owner) registers the plugin
  //          INSTANCE and lets the host derive the form from the entry id;
  //          there is no `installSection` at all, and edits are announced as
  //          `loader/volatile-update` on the fiber context.
  //
  // Calling the wrong one unconditionally is what took the whole plugin down:
  // `ctx.settings.installSection(...)` on 0.1.7 throws "is not a function" from
  // inside `apply`, which cordis reports as a failed entry rather than a
  // degraded card. So the branch below is capability-probed, never assumed.
  //
  // `settings` is declared in this plugin top-level `inject`, so the service is
  // available synchronously here. Declaring it is also what keeps the host from
  // rendering this namespace with no settings view and reading `undefined`
  // while it builds the provider list (the "Cannot read properties of
  // undefined (reading get)" failure).
  // ---------------------------------------------------------------------
  const settingsService = ctx.settings as unknown as {
    installSection?: (
      owner: Context,
      ns: SettingsNamespace,
      schema: typeof Config,
      entry: Config,
      hooks: typeof sectionHooks,
    ) => void
    /**
     * 0.1.7 presentation policy for this plugin instance. `auto: true` lets the
     * host derive the form from the entry schema; the returned disposer must be
     * registered with this plugin effects or the policy outlives disposal.
     */
    configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
    /**
     * Write paths. This service exposes NAMESPACE-scoped writers, not a bare
     * `set(key, value)`:
     *
     *   update(ns, patch)   merge a plain-object patch into the user section
     *   replace(ns, sect)   replace the user section wholesale
     *   mutate(ns, ops)     path-addressed edits
     *
     * Calling a non-existent `set` is what produced
     * "settings service unavailable; creditReserves was not saved" for every
     * save, on a machine where the service was present the whole time.
     */
    update?: (ns: SettingsNamespace, patch: Record<string, unknown>, expectedRevision?: unknown) => Promise<void> | void
  }
  if (typeof settingsService.installSection === 'function') {
    // 0.1.5: hand over the namespace and let the provider own the document.
    //
    // The config goes through `unwrapVolatileDeep` first: a volatile field is a
    // live `{get(): T}` reference on the lines that support the marker, and the
    // provider validates and structuredClones the whole object — a surviving
    // reference fails validation with a message naming the field but not the
    // cause, the namespace never registers, and the card silently disappears.
    // (On 0.1.5 the marker is a no-op, so this is the identity there.)
    settingsService.installSection(
      ctx,
      WORKBUDDY_POOL_SETTINGS_NS,
      Config,
      unwrapVolatileDeep(config),
      sectionHooks,
    )
  }
  if (typeof settingsService.configure === 'function') {
    // 0.1.7: the host derives the form from this entry and persists edits to
    // the profile patch itself. Registering the policy through `ctx.effect`
    // keeps the disposer wired to this plugin lifetime.
    ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}))
  }
  if (typeof settingsService.installSection !== 'function' && typeof settingsService.configure !== 'function') {
    ctx.logger.warn?.('dsh-workbuddy-xdpool: settings service exposes neither installSection nor configure; the card will not mount')
  }

  // On 0.1.7 a saved edit lands in the profile patch and is announced as
  // `loader/volatile-update`; the loader then hands the plugin a fresh live
  // reference. Re-applying here is what makes a save on the card take effect
  // without a host restart. The event does not exist on 0.1.5, which pushes
  // changes through `hooks.onChange` instead — so on that line this listener
  // simply never fires.
  ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
    .on('loader/volatile-update', () => { applyConfigFromSource() })

  /**
   * Write one key of the plugin's own settings section. Only ever called with
   * the three model-selection keys, so the settings file cannot be steered from
   * the browser; the catalog re-reads through `onChange` either way.
   */
  /**
   * Persist one settings key, then VERIFY it landed.
   *
   * The settings service resolves `set()` even when the write did not stick, so a
   * fire-and-forget call reports success while the file keeps the old value — and
   * the card then shows a value that silently reverts on the next read. That is
   * exactly the "I typed a reserve, reopened, and it still says 0" report: the
   * write was reported as saved but never reached the document. Every write now
   * awaits the setter and re-reads the document; a mismatch throws so the caller
   * surfaces a real error instead of claiming success.
   *
   * `expected` is what the caller believes it just wrote. Comparison goes through
   * a JSON round-trip so key order cannot cause a false mismatch.
   */
/**
 * Deep equality that ignores key order, used to verify a settings write.
 *
 * `JSON.stringify` is key-order sensitive, so comparing two equal objects whose
 * keys were inserted in a different order would report a false "not persisted"
 * failure — and a false failure on a write that DID land is as harmful as a
 * false success: it sends the user chasing a bug that is not there.
 */
function stableJsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

  /**
   * The namespace `settings.update` expects on the running line.
   *
   * 0.1.5 resolves writers by the NAMESPACE the plugin registered through
   * `installSection`, so the plugin picks it. 0.1.7 resolves them by the HOST
   * PLUGIN ENTRY ID instead (`configEditor.entries().find(row => row.options.id
   * === ns)`), and the profile patch chooses that id — the live Desktop host
   * mounts this plugin as `llm-workbuddy-xdpool`, but a marketplace install can
   * wrap it (`mkt-...`) or mount it through an `include` row. Asking the fiber
   * for its own entry id is therefore the only correct answer there; guessing
   * our own namespace makes every save throw `No configurable plugin entry`.
   */
  const settingsWriteNs: SettingsNamespace = typeof settingsService.installSection === 'function'
    ? WORKBUDDY_POOL_SETTINGS_NS
    : (() => {
        try {
          const entryId = (ctx.fiber as unknown as { entry?: { options?: { id?: string } } })?.entry?.options?.id
          return (entryId === undefined || entryId === '' ? WORKBUDDY_POOL_SETTINGS_NS : entryId) as SettingsNamespace
        } catch {
          // No fiber entry (a programmatic probe): fall back to the declared id.
          return WORKBUDDY_POOL_SETTINGS_NS
        }
      })()
  const setSetting = async (key: string, value: unknown, expected?: unknown): Promise<void> => {
    if (value === undefined) return
    const update = settingsService?.update
    if (update === undefined) {
      throw new Error(`settings service has no update(); ${key} was not saved`)
    }
    // The service writes PER NAMESPACE (or per entry id on 0.1.7), so the key
    // becomes a one-field patch. Await it: a rejection must reach the caller
    // instead of only the log.
    await update.call(settingsService, settingsWriteNs, { [key]: value })
    // A resolved write is NOT proof the document changed — the provider can
    // accept and drop. Re-read and compare; mismatching is a real failure and
    // must surface, because a silently-reverting value is worse than an error.
    if (expected !== undefined) {
      const stored = (current() as Record<string, unknown>)[key]
      if (!stableJsonEqual(stored, expected)) {
        throw new Error(`settings field "${key}" was not persisted`)
      }
    }
  }

  // Persist the automation's daily earnings ledger through the same settings
  // path everything else uses. Without this the ledger lives only in memory, so
  // a host restart mid-day would show nothing for rewards the automation had
  // genuinely collected.
  //
  // The scheduler restores it in its own constructor, which runs before the
  // settings source is installed, so the read here re-primes it: a ledger saved
  // earlier today is folded back in as soon as the document is available.
  core.scheduler.setEarningsPersistence(async (ledger) => {
    await setSetting('automationEarnings', ledger, ledger)
  })
  const storedLedger = current().automationEarnings
  if (storedLedger !== undefined) core.scheduler.applyEarningsLedger(storedLedger)


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
    // The scheduler holds a timer; stop it before the shims so a tick in flight
    // cannot reach an upstream client whose base has already gone.
    core.scheduler.stop()
  })

  // Same-origin routes backing the WorkBuddy XD Pool settings card. `webServer`
  // is an optional service: on a headless profile without it, no card routes
  // mount and the card shows an offline banner — the provider still works.
  ctx.inject(['webServer'], (webCtx) => registerPoolStatusRoute(webCtx, {
    pool: core.pool,
    catalogs: core.catalogs,
    client: core.client,
    shim: () => shimInfo('cn'),
    // The automation is pool-wide, not per region, so both routes read the same
    // scheduler snapshot.
    scheduler: () => core.scheduler.status(),
    // Starts the pass in the background and returns immediately: a full run takes
    // tens of seconds, and the card polls the status document for the result.
    runAutomation: (_job: string, _force: boolean) => core.scheduler.startRunAll(),
    // The settings section owns the model selection; this is the write half of
    // the card's save round-trip. It goes through `settingsScope.set` (below)
    // so the change lands in the same document the model picker reads.
    //
    // The region is written to its own key: saving the domestic tab must never
    // rewrite the international picker, because the two gateways advertise
    // different rosters and the user curates them separately.
    saveSelection: async (region, selection) => {
      const payload = {
        ...selection.enabledModelIds === undefined ? {} : { enabledModelIds: [...selection.enabledModelIds] },
        ...selection.imageModelIds === undefined ? {} : { imageModelIds: [...selection.imageModelIds] },
        ...selection.contextBudgets === undefined ? {} : { contextBudgets: { ...selection.contextBudgets } },
      }
      await setSetting(modelSelectionKeyFor(region), payload, payload)
    },
    // Flip one account in or out of the pool. Read-modify-write rather than a
    // full overwrite: the card sends one account per request, so two tabs
    // toggling different accounts cannot clobber each other.
    setAccountDisabled: async (accountId, disabled) => {
      const currentIds = current().disabledAccountIds ?? []
      const next = disabled
        ? currentIds.includes(accountId) ? currentIds : [...currentIds, accountId]
        : currentIds.filter(id => id !== accountId)
      await setSetting('disabledAccountIds', next, next)
    },
      // Set one account's reserved-credit floor. Also a read-modify-write:
      // the card sends a single account, so two tabs editing different
      // accounts cannot overwrite each other. A zero clears the entry rather
      // than storing it, so the settings file only names real reserves.
      setCreditReserve: async (accountId, reserve) => {
        const next = { ...current().creditReserves ?? {} }
        if (reserve > 0) next[accountId] = reserve
        else delete next[accountId]
        await setSetting('creditReserves', next, next)
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
  // Start the automation last, once every runtime object exists: a tick firing
  // immediately must not find a half-applied core. The scheduler no-ops while
  // `enabled` is false, so this is safe on an install that never opened the card.
  core.scheduler.start()

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
      //
      // The trailing `catch` is load-bearing, not tidiness: `scan()` rejects
      // whenever the WorkBuddy app cannot be located to open the credential
      // (`ENCRYPTED_CREDENTIAL`), and the `try` below covers only the per-region
      // loop. An unguarded rejection here is FATAL — the DSH host installs
      // `installFailLoud`, which turns any unhandled rejection into `exit(1)`,
      // so a missing app took the whole desktop down instead of degrading to
      // the static catalog. The sibling `void core.pool.scan().then(…)` above
      // already has a rejection handler; this one needs its own.
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
      })().catch((error: unknown) => {
        ctx.logger.warn('dsh-workbuddy-xdpool: account catalog seed failed', error)
      })
    }, (error: unknown) => {
      ctx.logger.error('dsh-workbuddy-xdpool: shim failed to listen', error)
    })
}

void ({} as unknown as Context | undefined)
export type { Context }
