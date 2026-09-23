/**
 * Node-free constants and types shared by the Host and browser halves of the
 * WorkBuddy XD Pool settings card.
 *
 * Pool's runtime state already lives in `src/status.ts` (`buildStatus` /
 * `WorkBuddyStatus`); this module only carves the cross-domain (Host→browser)
 * JSON document into a shape that stays token-free and matches what the
 * browser card renders. Route paths are plugin-owned and mounted on the Host's
 * same-origin web server (see `src/web-status.ts`).
 *
 * @module dsh-workbuddy-xdpool/status-paths
 */

/** Plugin-owned read-only pool status endpoint (account rows + models + shim). */
export const POOL_STATUS_PATH = '/plugins/dsh-workbuddy-xdpool/status'
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
export const POOL_RESCAN_PATH = '/plugins/dsh-workbuddy-xdpool/accounts/rescan'
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
export const POOL_RESET_COOLDOWN_PATH = '/plugins/dsh-workbuddy-xdpool/cooldowns/reset'
/** Plugin-owned daily check-in action endpoint (claim today's reward). */
export const POOL_CHECKIN_PATH = '/plugins/dsh-workbuddy-xdpool/checkin'
/** Plugin-owned model-selection save endpoint (writes the settings section). */
export const POOL_MODELS_SAVE_PATH = '/plugins/dsh-workbuddy-xdpool/models/save'

/** Switch one account in or out of the pool (card toggle). */
export const POOL_ACCOUNT_DISABLE_PATH = '/plugins/dsh-workbuddy-xdpool/accounts/disabled'

/** One pool account's row, token-free. */
export interface PoolWebAccount {
  id: string
  label: string
  nickname?: string
  domain: string
  /** ISO timestamp; absent when the credential carries no expiry. */
  expiresAt?: string
  /** Account-wide cooldown (every model blocked); only after a no-model penalize. */
  cooling: boolean
  /** ISO timestamp when the account-wide 429 cooldown lifts; only while cooling. */
  cooldownUntil?: string
  /**
   * Per-model cooldowns currently active. The account is NOT `cooling` while a
   * model is limited — its other models still serve — but each entry tells the
   * card which model is out until when (e.g. `hy4-preview` cooling to 10:14,
   * `hy3` normal).
   */
  modelCooldowns?: ReadonlyArray<{ modelId: string; until: string }>
  /**
   * Whether the user switched this account off. A disabled account never
   * serves a request, but it stays listed so the card can switch it back on.
   */
  disabled: boolean
  rateLimitHits: number
  /** ISO timestamp of the last successful use (best-effort pool bookkeeping). */
  lastUsedAt?: string
  /** Aggregated credit summary for the account, read-only. */
  credits?: PoolWebCredits
  creditsError?: string
  /**
   * Today's check-in state for this account, read-only. Present only when the
   * per-account check-in probe succeeded and the program is active. The card
   * renders one claim button per account, so a multi-account pool can collect
   * every account's daily reward without switching accounts by hand.
   */
  checkin?: PoolWebCheckin
  checkinError?: string
}

/** One credit package (as surfaced by the pool's upstream client), node-free. */
export interface PoolWebCreditPackage {
  packageName: string
  remain?: number
  size?: number
  /** CapacityType 4 — refreshed each cycle and never expires. */
  monthly?: boolean
  /** Next cycle refresh point, ms. */
  cycleRefreshMs?: number
  /** One-off expiry, ms. */
  expiresAtMs?: number
}

/** Aggregated credit answer the card renders under one account. */
export interface PoolWebCredits {
  total?: number
  packages: readonly PoolWebCreditPackage[]
  /** Credits expiring within 3 days. */
  expiringSoon?: number
  /** When the nearest package expires, ms. */
  nearestExpiryMs?: number
}

/**
 * Daily check-in state the card renders under one account's credits. Mirrors
 * the upstream activity endpoint, minus anything the browser does not need.
 */
export interface PoolWebCheckin {
  /** The activity is running; a claim button is offered only while true. */
  active: boolean
  /** Already collected today — the button renders as a done state. */
  todayCheckedIn: boolean
  /** Consecutive days checked in. */
  streakDays: number
  /** Credits a single day grants. */
  dailyCredit: number
  /** Credits collected today (0 before claiming). */
  todayCredit: number
  /** Today is a streak milestone day. */
  isStreakDay: boolean
  /** The day count the next milestone lands on. */
  nextStreakDay: number
  /** Bonus credits granted on a milestone day. */
  streakBonusCredit: number
}

/** Result of one claim, so the card can confirm what was collected. */
export interface PoolWebCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** One model the pool exposes to DSH, with cost / free tags. */
export interface PoolWebModel {
  id: string
  name: string
  /** Relative credit cost, e.g. 0.79 for x0.79. */
  multiplier?: number
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[]
  /** Effective image support after the user's per-model toggle. */
  supportsImages: boolean
  /** Effective context window after the user's budget cap. */
  contextWindow: number
  /** The window the upstream advertises, before any cap. */
  nativeContextWindow: number
  /** Upstream output ceiling, so the card can show both limits. */
  maxOutputTokens: number
  /** Thinking levels the upstream declares, when it declares any. */
  supportedEfforts?: readonly string[]
  /** Whether this model is currently enabled in the picker. */
  enabled: boolean
}

/** The user's saved model selection, echoed back so the card can diff a draft. */
/** Body of the account enable/disable route: exactly one account per request. */
export interface PoolWebAccountToggle {
  /** Pool account id, as reported in `PoolWebAccount.id`. */
  accountId: string
  /** `true` switches the account off; `false` puts it back in rotation. */
  disabled: boolean
}

export interface PoolWebModelSelection {
  /** Absent = every model is enabled. */
  enabledModelIds?: readonly string[]
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[]
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/** The JSON document the pool card renders. */
export interface PoolWebStatus {
  ok: boolean
  accounts: readonly PoolWebAccount[]
  /** The next account the pool would use (rotation cursor). */
  activeAccountId?: string
  cooling: number
  models: readonly PoolWebModel[]
  /** The saved selection the card diffs its draft against. */
  selection: PoolWebModelSelection
  /**
   * How the pool spreads requests: `priority` drains one account before
   * moving on, `round-robin` splits the spend evenly.
   */
  distribution: PoolDistribution
  /** Which region this document describes. */
  region: PoolRegion
  /** Every region holding at least one account, in display order. */
  regions: readonly PoolRegion[]
  shim: { running: boolean; baseUrl?: string }
  /** Daily-points automation state, so the card can show what ran and when. */
  automation: PoolWebAutomation
}

/** One automation job's last run, as shown on the card. */
export interface PoolWebAutomationJob {
  /** `YYYY-MM-DD` of the last run in this process, if it has run. */
  lastRunDate?: string
  /** Accounts that finished without error on the last run. */
  ok: number
  /** Accounts that failed on the last run (each one skipped, the run continued). */
  failed: number
  /** Credits claimed by the task job on the last run. */
  credit: number
  /** Energy claimed by the task job on the last run. */
  energy: number
  /** Tasks claimed by the task job on the last run. */
  claimed: number
  /** One-line summary of the last run. */
  message?: string
}

/**
 * Automation block on the status document.
 *
 * Carries the schedule and each job's last outcome so the card can answer
 * "is it on, when does it run, and what did it last do" without reaching into
 * the scheduler itself.
 */
export interface PoolWebAutomation {
  /** Master switch, mirrored from the saved config. */
  enabled: boolean
  /** Whether the loop is currently running. */
  running: boolean
  /** Configured hours per job, so the card can show the schedule. */
  checkinHours: readonly number[]
  reportHours: readonly number[]
  taskHours: readonly number[]
  streakHours: readonly number[]
  jobs: {
    checkin: PoolWebAutomationJob
    report: PoolWebAutomationJob
    tasks: PoolWebAutomationJob
    streak: PoolWebAutomationJob
  }
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number
}


/**
 * The two gateways, matching the provider ids the host registers. `cn` is the
 * domestic gateway (`copilot.tencent.com` / `codebuddy.cn`); `global` is the
 * international one (`workbuddy.ai`).
 */
export type PoolRegion = 'cn' | 'global'

/** How the pool spreads requests across its accounts. */
export type PoolDistribution = 'priority' | 'round-robin' | 'balanced'

