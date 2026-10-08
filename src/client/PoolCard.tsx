/**
 * WorkBuddy XD Pool card contributed to DSH Plugin configuration.
 *
 * The card body mirrors the LaoDing plugin family used by dingminhua's
 * `dsh-connect-workbuddy`: a small status row (dot + count + Rescan / Clear
 * cooldowns buttons), then a per-account panel showing label / status tag /
 * token expiry / cooldown info / credit packages, then the model directory
 * with per-model free/limited/night/image badges and context size.
 *
 * Rendered as a full settings page (see `client/index.tsx`): the shell gives it
 * a left-nav row and a scrollable content column, so everything is visible at
 * once — a fold inside the page only hid the pool behind a click.
 *
 * @module dsh-workbuddy-xdpool/client/PoolCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  POOL_ACCOUNT_DISABLE_PATH,
  POOL_ACCOUNT_IGNORE_PATH,
  POOL_AUTOMATION_RUN_PATH,
  POOL_CATALOG_REFRESH_PATH,
  POOL_CREDIT_RESERVE_PATH,
  POOL_CHECKIN_PATH,
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebAccount,
  type PoolWebAutomationJob,
  type PoolWebModel,
  type PoolWebStatus,
  type PoolRegion,
  type PoolWebCreditPackage,
  type PoolDistribution,
} from '../status-paths.ts'
import { DEFAULT_AUTOMATION_HOURS } from '../status-paths.ts'
import { POOL_PLUGIN_ICON } from './icon.ts'
import { POOL_CARD_CSS } from './styles.ts'
import { isFreeNow, promoStatusFor } from '../promo.ts'
import { paidAlternativeFor } from '../siblings.ts'
import type { PaidSibling } from '../siblings.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface PoolCardInjected {
  t: (key: WorkBuddyPoolSettingsKey, params?: Record<string, unknown>) => string
  /**
   * The plugin settings section the card reads and writes. Model selection
   * lives here, which is what makes it apply to the whole pool rather than to
   * whichever account is currently serving.
   */
  settingsScope: PoolCardSettingsScope
}

/** The settings scope the slot hands the card, narrowed to what it uses. */
export interface PoolCardSettingsScope {
  getSnapshot(): { writable?: boolean; value?: unknown }
  subscribe?(listener: () => void): () => void
  /** Write one field of the plugin settings section. */
  set?(field: string, value: unknown): Promise<void> | void
}

/** Props delivered by the Plugin configuration item slot. */
/**
 * Props delivered by the Plugin configuration item slot.
 *
 * `settingsScope` is supplied at runtime by the settings-plugins slot for
 * cards that declare a settings section. `PropsRuntime` does not type it, so
 * it is declared here as optional — every use site guards for its absence and
 * falls back to a read-only card.
 */
export type PoolCardProps = PropsRuntime<'settings.plugin.item'>
  & Partial<PoolCardInjected>
  & { settingsScope?: PoolCardSettingsScope }

/**
 * Default context window the card offers as the "capped" choice, in tokens.
 * Mirrors the host-side DEFAULT_CONTEXT_BUDGET; declared here rather than
 * imported, because the browser bundle must not pull in the host entry.
 */
const DEFAULT_CONTEXT_BUDGET = 200_000

const POLL_INTERVAL_MS = 30_000

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-workbuddy-xdpool/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = POOL_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-workbuddy-xdpool'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = POOL_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return '–'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatDateTime(value: string | undefined): string {
  if (value === undefined) return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms))
}

/**
 * The automation jobs, in the order they run.
 *
 * The order is the contract: the report has to land before the task pass, or
 * the task pass reads progress the report would have lit. `hoursOf` reads the
 * matching hour list off the status document so the panel stays in step with
 * whatever schedule the scheduler is actually running on.
 */
/**
 * How long to watch a manual run before giving up on it.
 *
 * A pass runs one upstream call per account per job, so ~30s for a handful of
 * accounts. The bound exists so a wedged run cannot spin the button forever;
 * the run itself keeps going in the background either way.
 */
const AUTOMATION_POLL_MS = 2000
const AUTOMATION_POLL_ATTEMPTS = 90

// The card renders one row per kind, and the list must match the scheduler's
// `AUTOMATION_JOB_KINDS` exactly — they are two hand-written lists that have to
// agree, and a kind missing here is invisible (the job runs, nothing shows it).
export const AUTOMATION_JOBS = ['checkin', 'report', 'tasks', 'streak', 'travel'] as const

export type AutomationJobKind = typeof AUTOMATION_JOBS[number]

/**
 * The hour list to save for one job: what the card holds, or the default.
 *
 * Mirrors the host's own fallback (`hoursOrDefault` in `scheduler.ts`). An
 * empty list must resolve to the default on BOTH sides, or the card would save
 * a schedule the scheduler then refuses to run — the exact silent standstill
 * this pair of fixes exists to remove.
 */
function hoursOrDefault(configured: readonly number[] | undefined, fallback: readonly number[]): number[] {
  return configured !== undefined && configured.length > 0 ? [...configured] : [...fallback]
}

/** Read one job's configured hours off the status document. */
function automationHours(status: PoolWebStatus, kind: AutomationJobKind): readonly number[] {
  const automation = status.automation
  if (automation === undefined) return []
  switch (kind) {
    case 'report': return automation.reportHours
    case 'tasks': return automation.taskHours
    case 'checkin': return automation.checkinHours
    case 'streak': return automation.streakHours
    case 'travel': return automation.travelHours
  }
}

/** Read one job's last-run record off the status document. */
function automationJob(status: PoolWebStatus, kind: AutomationJobKind): PoolWebAutomationJob | undefined {
  return status.automation?.jobs[kind]
}

function dotColor(status: 'ok' | 'error' | 'idle'): string {
  return status === 'ok'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #ef4444)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
}

function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/**
 * The five ways the pool can hand out accounts.
 *
 * Order is the reading order of the picker: the recommended mode first, then
 * the two cache-friendly extremes, then the two spreading modes. The row is
 * laid out one chip per mode, so this list length is also the column count.
 */
const DIST_OPTIONS = ['sticky', 'priority', 'balanced', 'round-robin', 'expiry'] as const

type DistTranslator = PoolCardInjected['t'] | undefined

/** Localized name of one distribution mode. */
function distLabel(option: PoolDistribution, t: DistTranslator): string {
  if (option === 'sticky') return t?.('row.distSticky') ?? 'Per conversation'
  if (option === 'priority') return t?.('row.distPriority') ?? 'Priority'
  if (option === 'balanced') return t?.('row.distBalanced') ?? 'Balanced'
  if (option === 'expiry') return t?.('row.distExpiry') ?? 'Expiring first'
  return t?.('row.distRoundRobin') ?? 'Round-robin'
}

/** One-line explanation of what a mode does to caching and spend. */
function distHint(option: PoolDistribution, t: DistTranslator): string {
  if (option === 'sticky') return t?.('row.distStickyHint') ?? ''
  if (option === 'priority') return t?.('row.distPriorityHint') ?? ''
  if (option === 'balanced') return t?.('row.distBalancedHint') ?? ''
  if (option === 'expiry') return t?.('row.distExpiryHint') ?? ''
  return t?.('row.distRoundRobinHint') ?? ''
}

/** Pick the right promotion chip for a model. */
/** One model's draft state while the card holds unsaved edits. */
interface ModelDraftEntry {
  enabled: boolean
  images: boolean
  /** Context budget, or undefined to follow the model's native window. */
  budget?: number
}

/** Build the draft from the server's selection + catalog flags. */
function draftFromStatus(status: PoolWebStatus): Record<string, ModelDraftEntry> {
  const selection = status.selection
  const enabled = selection.enabledModelIds
  const images = selection.imageModelIds
  const budgets = selection.contextBudgets
  const out: Record<string, ModelDraftEntry> = {}
  for (const model of status.models) {
    const entry: ModelDraftEntry = {
      enabled: enabled === undefined || enabled.includes(model.id),
      images: images === undefined ? model.supportsImages : images.includes(model.id),
    }
    const budget = budgets?.[model.id]
    if (budget !== undefined) entry.budget = budget
    out[model.id] = entry
  }
  return out
}

/** True when the draft differs from what the server last reported. */
function draftIsDirty(status: PoolWebStatus, draft: Record<string, ModelDraftEntry>): boolean {
  const selection = status.selection
  const enabled = new Set(selection.enabledModelIds ?? status.models.filter(m => m.enabled).map(m => m.id))
  const images = new Set(
    selection.imageModelIds ?? status.models.filter(m => m.supportsImages).map(m => m.id),
  )
  const budgets = selection.contextBudgets ?? {}
  for (const model of status.models) {
    const entry = draft[model.id]
    if (entry === undefined) continue
    if (entry.enabled !== enabled.has(model.id)) return true
    if (entry.images !== images.has(model.id)) return true
    const saved = budgets[model.id] ?? model.nativeContextWindow
    const next = entry.budget ?? model.nativeContextWindow
    if (saved !== next) return true
  }
  return false
}

/** Absolute expiry with the time of day: the upstream grants one-off packages at
 *  arbitrary clock times, so "expires 09/19 15:36" is what the user needs — a
 *  date alone would read as if it lapsed at midnight. */
function formatExpiry(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

/** Whole days until `ms`, floored at 0; undefined when there is no deadline. */
function daysUntil(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.max(0, Math.floor((ms - Date.now()) / 86_400_000))
}

/** True when a one-off package lapses inside the "expiring soon" window. */
function isExpiringSoon(pack: PoolWebCreditPackage): boolean {
  if (pack.monthly === true) return false
  const days = daysUntil(pack.expiresAtMs)
  return days !== undefined && days <= 3
}

/**
 * The promo badge for one model, or undefined when it has none.
 *
 * Two sources, because the gateway models one of them and not the other:
 *
 *  - `free` comes from the CREDIT MULTIPLIER. Neither gateway ever sends a
 *    literal `free` tag, but it does price its free models at `credits: "x0.00"`
 *    (CN `hy3`), so the multiplier is the honest signal.
 *  - the NIGHT window comes from {@link promoStatusFor}, because the gateway
 *    charges `x0.29` for `hy4-preview` around the clock and has no field for a
 *    time-of-day rule. See that module for why the 14-day newcomer allowance is
 *    deliberately not modelled.
 *
 * `region` is threaded through because the campaigns are REGIONAL: the
 * Hy3 / Hy4-preview extension is a domestic promotion, so a global roster must
 * not pick up a discount that gateway does not offer.
 */
function tagFor(
  model: PoolWebModel,
  now: Date,
  region: 'cn' | 'global',
): 'free' | 'limited' | 'night' | undefined {
  const tags = model.tags ?? []
  const promo = promoStatusFor(model, now, region)
  // A currently-active window outranks a bare multiplier: "free until 08:00" is
  // the more useful fact, and it is the one that expires.
  if (promo?.kind === 'night') return 'night'
  if (tags.includes('free') || model.multiplier === 0) return 'free'
  if (tags.includes('limited-free')) return 'limited'
  if (tags.includes('night-discount')) return 'night'
  return undefined
}

/** Render pool health, per-account credits/cooldown, and the model directory. */
export function PoolCard({ t, settingsScope }: PoolCardProps) {
  // The slot tells us whether the settings document is writable; a
  // read-only scope (locked profile) renders the model rows disabled.
  const settingsWritable = settingsScope?.getSnapshot().writable === true
  /** Which region tab is showing. A CN-only install never leaves this. */
  const [activeRegion, setActiveRegion] = useState<'cn' | 'global'>('cn')
  /**
   * Last-known status per region. Kept per region (not a single slot) so
   * switching tabs shows the other side's last answer immediately instead of
   * a blank frame, and the tab dots stay meaningful while a tab is hidden.
   */
  const [statusByRegion, setStatusByRegion] = useState<
    Partial<Record<PoolRegion, PoolWebStatus>>
  >({})

  /** The document for the tab on screen; undefined until its first answer. */
  const status = statusByRegion[activeRegion]
  /**
   * Today's automation take, summed across accounts.
   *
   * Summed from the per-account counters rather than kept separately, so the
   * panel total and the per-account lines can never disagree.
   */
  const automationTotals = Object.values(status?.automation?.earningsToday ?? {})
    .reduce((sum, entry) => ({
      credit: sum.credit + entry.credit,
      energy: sum.energy + entry.energy,
      claimed: sum.claimed + entry.claimed,
      checkinCredit: sum.checkinCredit + entry.checkinCredit,
      bonusCredit: sum.bonusCredit + entry.bonusCredit,
      travelCredit: sum.travelCredit + entry.travelCredit,
    }), { credit: 0, energy: 0, claimed: 0, checkinCredit: 0, bonusCredit: 0, travelCredit: 0 })
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [cooldownBusy, setCooldownBusy] = useState(false)
  /** Model-catalog refresh in flight (separate from the account rescan). */
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [automationBusy, setAutomationBusy] = useState(false)
  /** The automation job currently running from the card, if any. */
  const [automationRun, setAutomationRun] = useState<AutomationJobKind | 'all' | undefined>(undefined)
  /** Account id whose reserved-credit floor is being saved, if any. */
  const [reserveBusy, setReserveBusy] = useState<string | undefined>(undefined)
  const [flash, setFlash] = useState<string | undefined>(undefined)
  /** Account id whose daily claim is currently in flight. */
  const [checkinBusyId, setCheckinBusyId] = useState<string | undefined>(undefined)
  /** Account id whose enable/disable switch is in flight, if any. */
  const [accountBusyId, setAccountBusyId] = useState<string | undefined>(undefined)
  /**
   * Draft model selection. `undefined` means "no local edits"; once a checkbox
   * is touched the draft takes over and is what the Save button posts. Discard
   * drops it back to the copy the server last reported.
   */
  const [draftByRegion, setDraftByRegion] = useState<Partial<Record<PoolRegion, Record<string, ModelDraftEntry>>>>({})
  /**
   * The draft for the tab on screen. Keyed by region: the two gateways have
   * different rosters, so edits made on one tab must not leak into the other
   * when the user switches tabs (or saves).
   */
  const draft = draftByRegion[activeRegion]
  const setDraft = (next: Record<string, ModelDraftEntry> | undefined): void => {
    setDraftByRegion(prev => ({ ...prev, [activeRegion]: next }))
  }
  const [savingModels, setSavingModels] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /**
   * Fetch one region's status. `region` is a parameter rather than a closure
   * read so the callback identity does not change with the tab: the polling
   * effect can key off it without restarting on every switch, and each region's
   * last answer stays in its own slot (see `statusByRegion`).
   */
  const refresh = useCallback(async (region: PoolRegion, signal?: AbortSignal): Promise<PoolWebStatus | undefined> => {
    try {
      const response = await fetch(`${POOL_STATUS_PATH}?region=${region}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (mounted.current && signal?.aborted !== true) {
        setStatusByRegion(prev => ({ ...prev, [region]: value as PoolWebStatus }))
        setError(undefined)
      }
      // Returned so a caller that needs to poll a field (the automation run
      // state) can read the fresh value instead of a stale render.
      return value as PoolWebStatus
    } catch (cause: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      return undefined
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(activeRegion, controller.signal)
    const timer = window.setInterval(() => { void refresh(activeRegion, controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [refresh, activeRegion])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_RESCAN_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { accounts?: number; error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      await refresh(activeRegion)
      if (mounted.current) setFlash(t?.('row.accountsRescanned', { count: body.accounts ?? 0 }) ?? '')
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Re-fetch the upstream model catalog for both regions.
   *
   * Its own action, and its own BUTTON, because the account rescan beside it
   * could not do this job: when the startup fetch failed, the picker held the
   * shorter built-in list and "detect accounts again" left it untouched, so the
   * only recovery was restarting DSH. Users reasonably assumed the button
   * covered both.
   */
  const refreshCatalog = async (): Promise<void> => {
    setCatalogBusy(true)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_CATALOG_REFRESH_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as {
        regions?: Record<string, { source?: string; models?: number }>
        error?: string
      }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      await refresh(activeRegion)
      const here = body.regions?.[activeRegion]
      if (mounted.current) {
        setFlash(here?.source === 'live'
          ? (t?.('row.catalogRefreshed', { count: here.models ?? 0 }) ?? '')
          : (t?.('row.catalogRefreshOffline') ?? ''))
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setCatalogBusy(false)
    }
  }

  const resetCooldowns = async (): Promise<void> => {
    setCooldownBusy(true)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_RESET_COOLDOWN_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh(activeRegion)
      if (mounted.current) setFlash(t?.('row.resetCooldownsDone') ?? '')
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setCooldownBusy(false)
    }
  }

  /**
   * Claim one account's daily check-in. The account id travels in the body so
   * the Host can never guess: a click on account B's button can only ever
   * collect account B's reward. The status is re-read afterwards so the card
   * reflects the new streak / total without waiting for the next poll.
   */
  const claimCheckin = async (accountId: string): Promise<void> => {
    setCheckinBusyId(accountId)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_CHECKIN_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId }),
      })
      const body = await response.json().catch(() => undefined) as
        | { claim?: { credit?: number }; error?: string }
        | undefined
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      await refresh(activeRegion)
      const credit = body?.claim?.credit ?? 0
      if (mounted.current) {
        setFlash(t?.('row.checkinClaimedReward', { credit: formatNumber(credit) })
          ?? `Claimed +${formatNumber(credit)} credits`)
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setCheckinBusyId(undefined)
    }
  }

  /**
   * Switch one account in or out of the pool.
   *
   * The id travels in the body and the host validates it against the accounts it
   * really knows, so a stale tab cannot write an orphan id. Disabling only stops
   * the account from being picked — it stays listed so it can be turned back on —
   * and the change is saved through the settings section, so it survives a
   * restart and is re-applied after every re-scan.
   */
  const toggleAccountDisabled = async (accountId: string, disabled: boolean): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setError(t?.('row.modelsSaveError', { message: 'settings scope is read-only' })
        ?? 'settings scope is read-only')
      return
    }
    setAccountBusyId(accountId)
    setFlash(undefined)
    try {
      // Derived from the status the card already holds, so the write is a
      // read-modify-write of the full list and two clicks cannot clobber.
      const current = (status?.accounts ?? [])
        .filter(account => account.disabled === true)
        .map(account => account.id)
      const next = disabled
        ? (current.includes(accountId) ? current : [...current, accountId])
        : current.filter(id => id !== accountId)
      await write.call(settingsScope, 'disabledAccountIds', next)
      await refresh(activeRegion)
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (mounted.current) {
        setError(t?.('row.accountToggleError', { message }) ?? 'Could not switch the account: ' + message)
      }
    } finally {
      if (mounted.current) setAccountBusyId(undefined)
    }
  }

  /**
   * Throw one account out of the pool for good, or take it back.
   *
   * The host owns the ignore file, so this is a plain route call: no settings
   * scope is involved, which is also why it keeps working on a profile whose
   * settings section is read-only.
   */
  const setAccountIgnored = async (accountId: string, ignored: boolean): Promise<void> => {
    setAccountBusyId(accountId)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_ACCOUNT_IGNORE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, ignored }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `HTTP ${response.status}`)
      }
      await refresh(activeRegion)
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (mounted.current) {
        setError(t?.('row.accountIgnoreError', { message }) ?? 'Could not change the ignore list: ' + message)
      }
    } finally {
      if (mounted.current) setAccountBusyId(undefined)
    }
  }

  /** Keep the draft in step with the server copy while nothing is dirty. */
  const modelDraft = draft ?? (status === undefined ? {} : draftFromStatus(status))
  /** Model edits need a writable settings scope; otherwise the rows are read-only. */
  const modelsEditable = settingsWritable
  const modelsDirty = draft !== undefined && status !== undefined && draftIsDirty(status, draft)
  const enabledCount = Object.values(modelDraft).filter(entry => entry.enabled).length
  /**
   * One clock reading per render, shared by the sort and every row.
   *
   * Taken once so the list cannot disagree with itself: calling `new Date()`
   * per row would let a model be "free" for the badge and "not free" for the
   * sort if the window boundary happened to fall between two rows.
   *
   * A promotion boundary is not a re-render trigger — the card refreshes on its
   * own poll, which is frequent enough for a badge that changes twice a day.
   */
  const now = new Date()

  const toggleModel = (id: string): void => {
    if (status === undefined) return
    const base = draft ?? draftFromStatus(status)
    const entry = base[id]
    if (entry === undefined) return
    setDraft({ ...base, [id]: { ...entry, enabled: !entry.enabled } })
  }

  const toggleModelImage = (id: string): void => {
    if (status === undefined) return
    const base = draft ?? draftFromStatus(status)
    const entry = base[id]
    if (entry === undefined) return
    setDraft({ ...base, [id]: { ...entry, images: !entry.images } })
  }

  const setModelBudget = (id: string, budget: number): void => {
    if (status === undefined) return
    const base = draft ?? draftFromStatus(status)
    const entry = base[id]
    if (entry === undefined) return
    setDraft({ ...base, [id]: { ...entry, budget } })
  }

  const discardModels = (): void => {
    setDraft(undefined)
    setFlash(undefined)
  }

  /**
   * Persist the draft. The route validates the payload again on the host side,
   * so a malformed draft is rejected there rather than silently stored. The
   * card refuses to save an empty enable-list: that would leave the picker
   * with nothing to offer and no obvious way back.
   */
  /**
   * Persist the draft into the plugin settings section.
   *
   * The write goes through `settingsScope` rather than a bespoke route: that is
   * the same document the model picker reads, so one save covers every account
   * and survives account rotation — the selection is a property of the pool,
   * not of whichever account happens to be serving right now.
   *
   * The card refuses an empty enable-list: saving one would leave the picker
   * with nothing to offer and no obvious way back.
   */
  /**
   * Switch how the pool spreads requests. Written straight through the
   * settings scope (that is where the host keeps the pool options), so the
   * change lands without a restart and survives the next card refresh.
   */
  const setDistribution = async (next: PoolDistribution): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setError(t?.('row.modelsSaveError', { message: 'settings scope is read-only' })
        ?? 'settings scope is read-only')
      return
    }
    setFlash(undefined)
    try {
      await write.call(settingsScope, 'distribution', next)
      await refresh(activeRegion)
    } catch (cause: unknown) {
      if (mounted.current) setError(String(cause))
    }
  }

  /**
   * Switch the daily-points automation on or off.
   *
   * The whole `automation` object is written as one key, because that is how the
   * settings document stores it: the schedule fields must be carried along, or a
   * save would drop the hour lists the scheduler is running on.
   */
  const setAutomationEnabled = async (enabled: boolean): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setError(t?.('row.modelsSaveError', { message: 'settings scope is read-only' })
        ?? 'settings scope is read-only')
      return
    }
    const existing = status?.automation
    setAutomationBusy(true)
    setFlash(undefined)
    try {
      // Every schedule field is carried along, `travelHours` included: it used
      // to be missing from this list, so toggling the switch silently DROPPED
      // the travel schedule from the saved document — and because the host then
      // read the key as absent, the card could never write it back either.
      //
      // Each list also falls back to the same defaults the host uses when it is
      // empty, so a document already holding `[]` (the shape the schema
      // materializes for "never configured") is healed by the next toggle
      // rather than written back as an unrunnable schedule.
      await write.call(settingsScope, 'automation', {
        checkinHours: hoursOrDefault(existing?.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin),
        reportHours: hoursOrDefault(existing?.reportHours, DEFAULT_AUTOMATION_HOURS.report),
        taskHours: hoursOrDefault(existing?.taskHours, DEFAULT_AUTOMATION_HOURS.tasks),
        streakHours: hoursOrDefault(existing?.streakHours, DEFAULT_AUTOMATION_HOURS.streak),
        travelHours: hoursOrDefault(existing?.travelHours, DEFAULT_AUTOMATION_HOURS.travel),
        enabled,
      })
      await refresh(activeRegion)
    } catch (cause: unknown) {
      if (mounted.current) setError(String(cause))
    } finally {
      if (mounted.current) setAutomationBusy(false)
    }
  }

  /**
  /**
   * Run the whole automation pass now.
   *
   * The route only STARTS the pass: a full run takes tens of seconds, which is
   * far too long to hold a request open. This watches the scheduler status until
   * the run settles, so the panel can show "running" honestly and report the
   * result when it lands.
   */
  const runAutomationJob = async (): Promise<void> => {
    setAutomationRun('all')
    setFlash(undefined)
    try {
      const response = await fetch(POOL_AUTOMATION_RUN_PATH, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ job: 'all' }),
      })
      const body = await response.json() as { error?: string; started?: boolean }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (body.started === false) {
        // A run is already going; the status poll below reports its outcome.
        if (mounted.current) setFlash(t?.('row.autoAlreadyRunning') ?? 'A run is already in progress')
      }

      // Poll until the scheduler reports the run finished. Bounded so a wedged
      // run cannot leave the button spinning forever.
      let settled = false
      for (let attempt = 0; attempt < AUTOMATION_POLL_ATTEMPTS; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, AUTOMATION_POLL_MS))
        if (!mounted.current) return
        const fresh = await refresh(activeRegion)
        if (fresh?.automation?.runInProgress === false) { settled = true; break }
      }
      await refresh(activeRegion)
      if (mounted.current) {
        setFlash(settled
          ? (t?.('row.autoRunDone') ?? 'Automation pass finished')
          : (t?.('row.autoRunTimeout') ?? 'Still running; check back in a moment'))
      }
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setAutomationRun(undefined)
    }
  }

  /**
   * Save one account reserved-credit floor.
   *
   * A reserve only protects credits if the pool knows the balance, so this
   * also refreshes the account list afterwards: the reserve badge appears
   * as soon as the reading crosses the floor.
   */
  /**
   * Save one account reserved-credit floor.
   *
   * A reserve only protects credits if the pool knows the balance, so this also
   * refreshes the account list afterwards: the reserve badge appears as soon as
   * the reading crosses the floor.
   *
   * Returns whether the host CONFIRMED the write. The card keys its inline
   * "saved / not saved" note off this, so a failure is shown where the user is
   * looking instead of only in the card-level notice line.
   */
  const saveCreditReserve = async (accountId: string, reserve: number): Promise<boolean> => {
    setReserveBusy(accountId)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_CREDIT_RESERVE_PATH, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accountId, reserve }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      await refresh(activeRegion)
      if (mounted.current) {
        setFlash(reserve > 0
          ? (t?.('row.reserveSaved', { credits: reserve }) ?? `Keeping ${reserve} credits`)
          : (t?.('row.reserveCleared') ?? 'Reserve cleared'))
      }
      return true
    } catch (cause: unknown) {
      // Reported to the caller (inline note) AND to the card-level error line:
      // the inline note says what failed, the line says why.
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mounted.current) setReserveBusy(undefined)
    }
  }

  const saveModels = async (): Promise<void> => {
    if (draft === undefined || status === undefined) return
    if (enabledCount === 0) {
      setError(t?.('row.modelsEmpty') ?? 'No model enabled')
      return
    }
    const write = settingsScope?.set
    if (write === undefined) {
      setError(t?.('row.modelsSaveError', { message: 'settings scope is read-only' })
        ?? 'settings scope is read-only')
      return
    }
    setSavingModels(true)
    setFlash(undefined)
    try {
      // Every id the catalog knows about, so a model added upstream while the
      // card sat open is not silently dropped by an unrelated save.
      const enabledModelIds = Object.entries(draft).filter(([, e]) => e.enabled).map(([id]) => id)
      const imageModelIds = Object.entries(draft).filter(([, e]) => e.images).map(([id]) => id)
      const contextBudgets: Record<string, number> = {}
      for (const [id, entry] of Object.entries(draft)) {
        if (entry.budget !== undefined) contextBudgets[id] = entry.budget
      }
      // One key per region: saving this tab must not rewrite the other tab's list.
      const key = activeRegion === 'cn' ? 'modelSelectionCn' : 'modelSelectionGlobal'
      await write.call(settingsScope, key, { enabledModelIds, imageModelIds, contextBudgets })
      setDraft(undefined)
      if (mounted.current) setFlash(t?.('row.modelsSaved') ?? 'Saved')
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(t?.('row.modelsSaveError', { message: cause instanceof Error ? cause.message : String(cause) })
          ?? String(cause))
      }
    } finally {
      if (mounted.current) setSavingModels(false)
    }
  }

  const title = t?.('row.title') ?? 'WorkBuddy XD Pool'
  const description = t?.('row.desc') ?? ''
  const accountCount = status?.accounts.length ?? 0
  const cooling = status?.cooling ?? 0
  const idle = status === undefined && error === undefined
  const hasHealthy = accountCount > 0 && cooling < accountCount
  const state: 'ok' | 'error' | 'idle' = error !== undefined
    ? 'error'
    : (idle ? 'idle' : (hasHealthy ? 'ok' : 'idle'))
  /** Human label for the active tab, used inside the empty-state copy. */
  const regionLabel = activeRegion === 'cn'
    ? (t?.('row.tabCn') ?? 'CN')
    : (t?.('row.tabGlobal') ?? 'Global')

  const stateLabel = error !== undefined
    ? (t?.('row.requestFailed') ?? 'Request failed')
    : accountCount === 0
      ? (t?.('row.regionEmpty') ?? t?.('row.poolEmpty') ?? 'No account yet')
      : state === 'ok'
        ? (t?.('row.ok') ?? 'Healthy')
        : (t?.('row.allCooling') ?? 'All cooling')
  const shimRunning = status?.shim.running === true
  const shimHint = status === undefined
    ? null
    : shimRunning
      ? `${t?.('row.shimRunning') ?? 'Provider listening'}${status.shim.baseUrl === undefined ? '' : ` · ${status.shim.baseUrl}`}`
      : (t?.('row.shimStopped') ?? 'Provider loopback not running')

  return (
    <section className="dsm-workbuddy-xdpool-page">
      <header className="dsm-workbuddy-xdpool-page-head">
        <img className="dsm-workbuddy-xdpool-page-icon" src={POOL_PLUGIN_ICON} alt="" />
        <span className="dsm-workbuddy-xdpool-page-copy">
          <h2 className="dsm-workbuddy-xdpool-page-title">{title}</h2>
          <p className="dsm-workbuddy-xdpool-page-desc">{description}</p>
        </span>
        <div className="dsm-workbuddy-xdpool-page-actions">
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={busy}
            onClick={() => { void rescan() }}
          >
            {busy
              ? (t?.('row.accountsScanning') ?? 'Detecting…')
              : (t?.('row.accountsRescan') ?? 'Detect accounts again')}
          </button>
          {cooling > 0
            ? <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={cooldownBusy}
                onClick={() => { void resetCooldowns() }}
              >
                {cooldownBusy
                  ? (t?.('row.resetCooldownsBusy') ?? 'Clearing…')
                  : (t?.('row.resetCooldowns') ?? 'Clear all cooldowns')}
              </button>
            : null}
        </div>
      </header>
              {/* Region tabs: one supplier per tab. Both are always offered, so an
                  empty side reads as "not signed in here yet" rather than the tab
                  appearing only after the user has already signed in. */}
              <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-status">
              <div className="dsm-workbuddy-xdpool-tabs" role="tablist">
                    {status?.regions.map(region => (
                      <button
                        key={region}
                        type="button"
                        role="tab"
                        aria-selected={region === activeRegion}
                        className={`dsm-workbuddy-xdpool-tab${region === activeRegion ? ' dsm-workbuddy-xdpool-tab-active' : ''}`}
                        onClick={() => { setActiveRegion(region) }}
                      >
                        <span className="dsm-workbuddy-xdpool-tab-dot" data-state={state} />
                        {region === 'cn'
                          ? (t?.('row.tabCn') ?? 'CN')
                          : (t?.('row.tabGlobal') ?? 'Global')}
                      </button>
                    ))}
                  </div>
              <div className="dsm-workbuddy-xdpool-usage-head">
                <div className="dsm-workbuddy-xdpool-usage-copy" role="status">
                  <div className="dsm-workbuddy-xdpool-usage-status">
                    <span
                      aria-hidden="true"
                      className="dsm-workbuddy-xdpool-usage-dot"
                      style={{ background: dotColor(state) }}
                    />
                    <span>{stateLabel}</span>
                  </div>
                  {accountCount > 0
                    ? <p className="dsm-workbuddy-xdpool-usage-hint">
                        {t?.('row.accountsSummary', { count: accountCount, cooling })
                          ?? `${accountCount} account(s) · ${cooling} cooling`}
                      </p>
                    : null}
                  {shimHint === null ? null
                    : <p className="dsm-workbuddy-xdpool-usage-hint">{shimHint}</p>}
                  {/* How the pool spends: one account at a time, or spread evenly. */}
                  {status === undefined ? null
                    : <div className="dsm-workbuddy-xdpool-dist" role="radiogroup"
                        aria-label={t?.('row.distTitle') ?? 'Account usage'}>
                        <div className="dsm-workbuddy-xdpool-dist-head">
                          <span className="dsm-workbuddy-xdpool-dist-title">
                            {t?.('row.distTitle') ?? 'Account usage'}
                          </span>
                          {/* The active mode repeated as a badge in the header:
                              the answer to "which one is on?" without reading
                              four cards for the highlighted one. */}
                          <span className="dsm-workbuddy-xdpool-dist-now">
                            {distLabel(status.distribution ?? 'priority', t)}
                          </span>
                        </div>
                        <div className="dsm-workbuddy-xdpool-dist-options">
                        {DIST_OPTIONS.map(option => {
                          const active = (status.distribution ?? 'priority') === option
                          const label = distLabel(option, t)
                          const hint = distHint(option, t)
                          const cls = 'dsm-workbuddy-xdpool-dist-option'
                            + (active ? ' dsm-workbuddy-xdpool-dist-option-active' : '')
                          return (
                            <button
                              key={option}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              title={hint}
                              disabled={!modelsEditable}
                              className={cls}
                              onClick={() => { void setDistribution(option) }}
                            >
                              <span className="dsm-workbuddy-xdpool-dist-option-top">
                                <span className="dsm-workbuddy-xdpool-dist-option-name">{label}</span>
                                {option === 'sticky'
                                  ? <span className="dsm-workbuddy-xdpool-dist-option-badge">
                                      {t?.('row.distRecommended') ?? 'Recommended'}
                                    </span>
                                  : null}
                              </span>
                            </button>
                          )
                        })}
                        </div>
                        {/* One sentence for the mode that is actually on. Five
                            chips carrying five sentences each is five paragraphs;
                            this keeps the row a row and still explains the choice. */}
                        <p className="dsm-workbuddy-xdpool-dist-hint">
                          {distHint(status.distribution ?? 'priority', t)}
                        </p>
                      </div>}
                </div>
                <div className="dsm-workbuddy-xdpool-usage-actions">
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline"
                    disabled={busy}
                    onClick={() => { void rescan() }}
                  >
                    {busy
                      ? (t?.('row.accountsScanning') ?? 'Detecting…')
                      : (t?.('row.accountsRescan') ?? 'Detect accounts again')}
                  </button>
                  {cooling > 0
                    ? <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        disabled={cooldownBusy}
                        onClick={() => { void resetCooldowns() }}
                      >
                        {cooldownBusy
                          ? (t?.('row.resetCooldownsBusy') ?? 'Clearing…')
                          : (t?.('row.resetCooldowns') ?? 'Clear all cooldowns')}
                      </button>
                    : null}
                </div>
              </div>
              </section>

              {/* Daily-points automation: the schedule and each job's last run.
                  Off by default, so the panel leads with the switch and only
                  spells out the schedule once it is on. */}
              {/* Automation is CN-only: the international gateway has no growth/task
                  system at all, so showing the panel there would offer a switch that
                  can never do anything. */}
              {activeRegion !== 'cn' || status?.automation === undefined ? null
                : <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-auto" aria-label={t?.('row.autoTitle') ?? 'Automation'}>
                    <div className="dsm-workbuddy-xdpool-auto-head">
                      <span className="dsm-workbuddy-xdpool-auto-title">
                        {t?.('row.autoTitle') ?? 'Automation'}
                      </span>
                        {/* One button for the whole pass rather than one per job:
                            the jobs are ordered and share accounts, so running them
                            one by one is never what the user means. */}
                        {!status.automation.enabled ? null
                          : <button
                              type="button"
                              className="dsm-btn dsm-btn-outline dsm-workbuddy-xdpool-auto-run"
                              disabled={automationRun !== undefined}
                              onClick={() => { void runAutomationJob() }}
                            >
                              {automationRun !== undefined
                                ? (t?.('row.autoRunning') ?? 'Running…')
                                : (t?.('row.autoRunAll') ?? 'Run all now')}
                            </button>}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={status.automation.enabled}
                        disabled={!settingsWritable || automationBusy}
                        className={`dsm-workbuddy-xdpool-auto-switch${status.automation.enabled ? ' dsm-workbuddy-xdpool-auto-switch-on' : ''}`}
                        onClick={() => { void setAutomationEnabled(!status.automation.enabled) }}
                      >
                        {automationBusy
                          ? (t?.('row.autoBusy') ?? 'Saving…')
                          : status.automation.enabled
                            ? (t?.('row.autoOn') ?? 'On')
                            : (t?.('row.autoOff') ?? 'Off')}
                      </button>
                    </div>
                    <p className="dsm-workbuddy-xdpool-auto-hint">
                      {status.automation.enabled
                        ? (t?.('row.autoHintOn') ?? 'Reports activity, claims task rewards and checks in once a day.')
                        : (t?.('row.autoHintOff') ?? 'Off: no background requests are made for you.')}
                    </p>
                      {/* Today's take, split by source: "we claimed tasks" and "we
                          checked in" are different achievements, so one merged number
                          would hide which of them actually ran. */}
                      {automationTotals.credit === 0 && automationTotals.checkinCredit === 0
                        && automationTotals.bonusCredit === 0 && automationTotals.travelCredit === 0
                        ? null
                        : <div className="dsm-workbuddy-xdpool-auto-total">
                            <span className="dsm-workbuddy-xdpool-auto-total-label">
                              {t?.('row.autoToday') ?? 'Today'}
                            </span>
                            <span className="dsm-workbuddy-xdpool-auto-total-list">
                              {automationTotals.credit > 0
                                ? <span className="dsm-workbuddy-xdpool-auto-total-row">
                                    {t?.('row.autoFromTasks', { credit: automationTotals.credit, energy: automationTotals.energy, count: automationTotals.claimed })
                                      ?? `Tasks +${automationTotals.credit}`}
                                  </span>
                                : null}
                              {automationTotals.checkinCredit > 0
                                ? <span className="dsm-workbuddy-xdpool-auto-total-row">
                                    {t?.('row.autoFromCheckin', { credit: automationTotals.checkinCredit })
                                      ?? `Check-in +${automationTotals.checkinCredit}`}
                                  </span>
                                : null}
                              {automationTotals.bonusCredit > 0
                                ? <span className="dsm-workbuddy-xdpool-auto-total-row">
                                    {t?.('row.autoFromBonus', { credit: automationTotals.bonusCredit })
                                      ?? `Streak +${automationTotals.bonusCredit}`}
                                  </span>
                                : null}
                              {automationTotals.travelCredit > 0
                                ? <span className="dsm-workbuddy-xdpool-auto-total-row">
                                    {t?.('row.autoFromTravel', { credit: automationTotals.travelCredit })
                                      ?? `Buddy +${automationTotals.travelCredit}`}
                                  </span>
                                : null}
                            </span>
                          </div>}
                    {status.automation.enabled
                      ? <div className="dsm-workbuddy-xdpool-auto-jobs">
                          {AUTOMATION_JOBS.map(kind => {
                            const job = automationJob(status, kind)
                            const hours = automationHours(status, kind)
                            const label = t?.(`row.autoJob_${kind}`) ?? kind
                            return (
                                <div key={kind} className="dsm-workbuddy-xdpool-auto-job">
                                  <span className="dsm-workbuddy-xdpool-auto-job-name">{label}</span>
                                  <span className="dsm-workbuddy-xdpool-auto-job-when">
                                    {hours.length === 0
                                      ? (t?.('row.autoHourNone') ?? 'not scheduled')
                                      : hours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(' · ')}
                                  </span>
                                  <span className="dsm-workbuddy-xdpool-auto-job-last">
                                    {/* The TIME, not just the date. A date-only
                                        stamp cannot answer "did this run once
                                        today or eight times" — every repeat
                                        rendered as the same `2026-09-28 · 2`,
                                        which is exactly why the runaway
                                        re-run defect stayed invisible on the
                                        card and had to be found in the logs. */}
                                    {job?.lastRunAtMs === undefined
                                      ? (t?.('row.autoNever') ?? 'not run yet')
                                      : `${formatTime(job.lastRunAtMs)} · ${job.ok}${job.failed > 0 ? `/${job.failed}` : ''}`}
                                  </span>
                                  {job?.progress === undefined ? null
                                    : <span className="dsm-workbuddy-xdpool-auto-job-note">{job.progress}</span>}
                                  {job?.detail === undefined || job.detail.length === 0 ? null
                                    : <span className="dsm-workbuddy-xdpool-auto-job-detail">
                                        {job.detail.join(' · ')}
                                      </span>}
                                </div>
                            )
                          })}
                        </div>
                      : null}
                  </section>}
              {flash === undefined ? null
                : <p className="dsm-workbuddy-xdpool-note">{flash}</p>}
              {error === undefined ? null
                : <p className="dsm-workbuddy-xdpool-error">
                    {t?.('row.error', { message: error }) ?? `Pool status unavailable: ${error}`}
                  </p>}

              {accountCount === 0 && error === undefined
                ? <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-empty">
                    <p className="dsm-workbuddy-xdpool-empty-title">
                      {t?.('row.regionEmptyTitle', { region: regionLabel })
                        ?? t?.('row.regionEmpty') ?? 'No account yet'}
                    </p>
                    <div className="dsm-workbuddy-xdpool-empty-steps">
                      <p className="dsm-workbuddy-xdpool-empty-steps-title">
                        {t?.('row.regionHowToTitle', { region: regionLabel })
                          ?? `How to sign in to the ${regionLabel} version`}
                      </p>
                      <ol className="dsm-workbuddy-xdpool-empty-list">
                        <li>{t?.('row.regionHowTo1') ?? ''}</li>
                        <li>{t?.('row.regionHowTo2') ?? ''}</li>
                        <li>{t?.('row.regionHowTo3') ?? ''}</li>
                        <li>{t?.('row.regionHowTo4') ?? ''}</li>
                      </ol>
                    </div>
                    <p className="dsm-workbuddy-xdpool-empty-note">
                      {t?.('row.regionHowToNote') ?? ''}
                    </p>
                  </section>
                : null}

              {accountCount > 0
                ? <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-accounts" aria-label={t?.('row.accountsTitle') ?? 'Accounts'}>
                    <div className="dsm-workbuddy-xdpool-accounts-head">
                      <h3 className="dsm-workbuddy-xdpool-accounts-title">
                        {t?.('row.accountsTitle') ?? 'Accounts in the pool'}
                      </h3>
                      <p className="dsm-workbuddy-xdpool-accounts-summary">
                        {t?.('row.accountsSummary', { count: accountCount, cooling })
                          ?? `${accountCount} account(s) · ${cooling} cooling`}
                      </p>
                    </div>
                    {/* Files on disk that did not become accounts. Shown because
                        a pool of 2 next to 4 credential files otherwise reads as
                        "2 accounts were deleted" — this says which files could
                        not be opened and why, so the number is trustworthy. */}
                    {status?.skippedFiles === undefined || status.skippedFiles.length === 0 ? null
                      : <div className="dsm-workbuddy-xdpool-skipped">
                          <p className="dsm-workbuddy-xdpool-skipped-summary">
                            {t?.('row.skippedFiles', { count: status.skippedFiles.length })
                              ?? `${status.skippedFiles.length} credential file(s) could not be read`}
                          </p>
                          {status.skippedFiles.slice(0, 4).map(entry => (
                            <p key={entry.file} className="dsm-workbuddy-xdpool-skipped-row">
                              <span className="dsm-workbuddy-xdpool-skipped-file">{entry.file}</span>
                              <span className="dsm-workbuddy-xdpool-skipped-reason">
                                {entry.reason === 'encrypted'
                                  ? (t?.('row.skippedEncrypted') ?? 'encrypted — start WorkBuddy once')
                                  : entry.reason === 'unreadable'
                                    ? (t?.('row.skippedUnreadable') ?? 'file could not be read')
                                    : (t?.('row.skippedMalformed') ?? 'not a credential file')}
                              </span>
                            </p>
                          ))}
                        </div>}
                    {(() => {
                      // "In use now": the account that actually served the last request.
                      // It is recorded on success only, so it answers "which account am I
                      // using?" rather than "which one would be tried next".
                      const active = status?.activeAccountId === undefined
                        ? undefined
                        : status.accounts.find(account => account.id === status.activeAccountId)
                      if (active === undefined) return null
                      return (
                        <div className="dsm-workbuddy-xdpool-current">
                          <span className="dsm-workbuddy-xdpool-current-dot" />
                          <span className="dsm-workbuddy-xdpool-current-label">
                            {t?.('row.currentAccount') ?? 'In use now'}
                          </span>
                          <span className="dsm-workbuddy-xdpool-current-name">{active.label}</span>
                          {active.disabled === true
                            ? <span className="dsm-workbuddy-xdpool-current-note">
                                {t?.('row.currentAccountDisabled') ?? 'disabled — will switch on the next request'}
                              </span>
                            : null}
                        </div>
                      )
                    })()}
                    {status?.accounts.map(account => (
                      <AccountBlock
                        key={account.id}
                        account={account}
                        models={status?.models ?? []}
                        {...checkinBusyId === undefined ? {} : { checkinBusyId }}
                        onClaimCheckin={(accountId) => { void claimCheckin(accountId) }}
                        onSaveCreditReserve={(accountId, reserve) => saveCreditReserve(accountId, reserve)}
                          onToggleDisabled={(accountId, disabled) => { void toggleAccountDisabled(accountId, disabled) }}
                          onIgnoreAccount={(accountId) => { void setAccountIgnored(accountId, true) }}
                          {...accountBusyId === undefined ? {} : { accountBusyId }}
                        t={t}
                      />
                    ))}
                  </section>
                : null}

              {/* The ignored accounts, shown so "remove" is not a one-way door.
                  Each row can be restored, which is what makes the feature safe
                  to use on an account the user is merely unsure about. */}
              {(status?.ignored.length ?? 0) > 0
                ? <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-ignored" aria-label={t?.('row.ignoredTitle') ?? 'Removed accounts'}>
                    <div className="dsm-workbuddy-xdpool-ignored-head">
                      <h3 className="dsm-workbuddy-xdpool-ignored-title">
                        {t?.('row.ignoredTitle') ?? 'Removed accounts'}
                      </h3>
                      <p className="dsm-workbuddy-xdpool-ignored-summary">
                        {t?.('row.ignoredSummary', { count: status?.ignored.length ?? 0 })
                          ?? `${status?.ignored.length ?? 0} account(s) no longer in the pool`}
                      </p>
                    </div>
                    <div className="dsm-workbuddy-xdpool-ignored-list">
                      {(status?.ignored ?? []).map(entry => (
                        <div key={entry.id} className="dsm-workbuddy-xdpool-ignored-row">
                          <span className="dsm-workbuddy-xdpool-ignored-label">{entry.label}</span>
                          <button
                            type="button"
                            className="dsm-workbuddy-xdpool-ignored-restore"
                            title={t?.('row.ignoredRestoreHint') ?? 'Put this account back into the pool'}
                            disabled={accountBusyId === entry.id}
                            onClick={() => { void setAccountIgnored(entry.id, false) }}
                          >
                            {t?.('row.ignoredRestore') ?? 'Restore'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                : null}

              {(status?.models.length ?? 0) > 0
                ? <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-models" aria-label={t?.('row.modelsTitle') ?? 'Models'}>
                    <div className="dsm-workbuddy-xdpool-models-head">
                      <div className="dsm-workbuddy-xdpool-models-heading">
                        <h3 className="dsm-workbuddy-xdpool-models-title">
                          {t?.('row.modelsTitle') ?? 'Models'}
                        </h3>
                        <p className="dsm-workbuddy-xdpool-models-summary">
                          {t?.('row.modelsEnabledCount', {
                            enabled: enabledCount,
                            total: status?.models.length ?? 0,
                          }) ?? `${enabledCount} / ${status?.models.length ?? 0} enabled`}
                        </p>
                      </div>
                      <div className="dsm-workbuddy-xdpool-models-actions">
                        {/* The offline notice sits with the buttons, not in a
                            tooltip: the failure it reports is "you are looking
                            at a SHORTER list than the gateway offers", and a
                            user who cannot see that will file it as a bug about
                            missing models. */}
                        {status?.catalogSource !== 'fallback' ? null
                          : <span
                              className="dsm-workbuddy-xdpool-catalog-offline"
                              title={status.catalogError ?? undefined}
                            >
                              {t?.('row.catalogOffline') ?? 'built-in list (offline)'}
                            </span>}
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline"
                          disabled={catalogBusy}
                          onClick={() => { void refreshCatalog() }}
                          title={t?.('row.catalogRefreshHint') ?? 'Fetch the model list again from WorkBuddy'}
                        >
                          {catalogBusy
                            ? (t?.('row.catalogRefreshing') ?? 'Fetching…')
                            : (t?.('row.catalogRefresh') ?? 'Refresh models')}
                        </button>
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline"
                          disabled={!modelsDirty || savingModels}
                          onClick={discardModels}
                        >
                          {t?.('row.modelsDiscard') ?? 'Discard'}
                        </button>
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-primary"
                          disabled={!modelsDirty || savingModels || enabledCount === 0}
                          onClick={() => { void saveModels() }}
                        >
                          {savingModels
                            ? (t?.('row.modelsSaving') ?? 'Saving…')
                            : (t?.('row.modelsSave') ?? 'Save')}
                        </button>
                      </div>
                    </div>
                    <div className="dsm-workbuddy-xdpool-model-list">
                      {/* Free models first, so "what costs me nothing right
                          now" is the first thing the eye lands on. The sort is
                          STABLE within each group (Array.prototype.sort is
                          stable in modern V8), so the gateway's own ordering
                          survives inside the free and paid blocks alike.
                          Only CURRENTLY-free models float up: a model whose
                          night window is closed still costs credits, and
                          promoting it would misrepresent the list. */}
                      {[...(status?.models ?? [])]
                        .sort((a, b) => Number(isFreeNow(b, now, activeRegion)) - Number(isFreeNow(a, now, activeRegion)))
                        .map(model => (
                        <ModelRow
                          key={model.id}
                          model={model}
                          region={activeRegion}
                          paidTwin={paidAlternativeFor(model, status?.models ?? [])}
                          t={t}
                          draft={modelDraft[model.id] ?? { enabled: model.enabled, images: model.supportsImages }}
                          editable={modelsEditable}
                          onToggle={toggleModel}
                          onToggleImage={toggleModelImage}
                          onBudget={setModelBudget}
                        />
                      ))}
                    </div>
                  </section>
                : null}
    </section>
  )
}

/** One account block: label + status tag + meta + optional credit panels. */
function AccountBlock({
  account,
  models,
  t,
  checkinBusyId,
  onClaimCheckin,
  accountBusyId,
  onToggleDisabled,
  onIgnoreAccount,
  onSaveCreditReserve,
  reserveBusyId,
}: {
  account: PoolWebAccount
  /**
   * The current catalog, so a per-model cooldown can name the paid row of the
   * cooling model. Same roster the model list above is drawn from — a hint
   * built from a different list could name an id this gateway does not serve.
   */
  models: readonly PoolWebModel[]
  t?: PoolCardProps['t']
  /** Account id whose claim is in flight, if any. */
  checkinBusyId?: string
  onClaimCheckin: (accountId: string) => void
  /** Account id whose switch is in flight, if any. */
  accountBusyId?: string
  onToggleDisabled: (accountId: string, disabled: boolean) => void
  /** Throw this account out of the pool for good. */
  onIgnoreAccount: (accountId: string) => void
    onSaveCreditReserve: (accountId: string, reserve: number) => Promise<boolean>
    /** Account id whose reserve is being saved, if any. */
    reserveBusyId?: string
}) {
  const isDisabled = account.disabled === true
  const isCooling = account.cooling === true
  const isDead = account.credentialDead === true
  const cooldownUntil = account.cooldownUntil !== undefined ? Date.parse(account.cooldownUntil) : undefined
  const modelCooldowns = account.modelCooldowns ?? []

  // Only a whole-account cooldown gets a tag. Per-model cooldowns do NOT mark
  // the account cooling (its other models still serve) — they render as
  // per-model chips below instead, e.g. "hy4-preview cooling to 10:14".
  //
  // There is deliberately no "Next up" tag: which account serves next is not
  // knowable from here. `balanced` draws at random, `round-robin` walks a
  // cursor, and the old flag only ever meant "highest-priority eligible" —
  // which is not the same thing, and did not account for disabled accounts.
  //
  // A rejected sign-in outranks "cooling": a cooldown lifts on its own, this
  // one needs the user to sign in again, so it is the more useful thing to say.
  const tag = isDead
    ? { text: t?.('row.credentialDeadTag') ?? 'Sign-in rejected', cls: 'dsm-workbuddy-xdpool-account-tag dsm-workbuddy-xdpool-account-tag-dead' }
    : isCooling
      ? { text: t?.('row.cooling') ?? 'Cooling', cls: 'dsm-workbuddy-xdpool-account-tag dsm-workbuddy-xdpool-account-tag-cooling' }
      : null

  return (
    <div className={isDisabled ? 'dsm-workbuddy-xdpool-account dsm-workbuddy-xdpool-account-off' : 'dsm-workbuddy-xdpool-account'}>
      <div className="dsm-workbuddy-xdpool-account-head">
        <span className="dsm-workbuddy-xdpool-account-label">{account.label}</span>
        {tag === null ? null : <span className={tag.cls}>{tag.text}</span>}
        <button
          type="button"
          role="switch"
          aria-checked={!isDisabled}
          className={isDisabled
            ? 'dsm-workbuddy-xdpool-account-toggle'
            : 'dsm-workbuddy-xdpool-account-toggle dsm-workbuddy-xdpool-account-toggle-on'}
          title={t?.('row.accountToggleHint') ?? 'Enable this account (uncheck to keep it out of the pool)'}
          disabled={accountBusyId === account.id}
          onClick={() => { onToggleDisabled(account.id, !isDisabled) }}
        >
          <span className="dsm-workbuddy-xdpool-account-toggle-dot" />
          {isDisabled ? (t?.('row.accountOff') ?? 'Disabled') : (t?.('row.accountInRotation') ?? 'Enabled')}
        </button>
        {/* Throwing the account away for good. Deliberately a separate, plainly
            labelled button rather than a third state of the switch above:
            "stop using this for now" and "this account is not mine any more"
            are different decisions, and merging them into one control is how a
            user permanently drops an account by accident. */}
        <button
          type="button"
          className="dsm-workbuddy-xdpool-account-ignore"
          title={t?.('row.accountIgnoreHint') ?? 'Remove this account from the pool for good'}
          disabled={accountBusyId === account.id}
          onClick={() => { onIgnoreAccount(account.id) }}
        >
          {t?.('row.accountIgnore') ?? 'Remove'}
        </button>
      </div>
      <div className="dsm-workbuddy-xdpool-account-body">
        <div className="dsm-workbuddy-xdpool-account-copy">
          {account.expiresAt !== undefined
            ? <span className="dsm-workbuddy-xdpool-account-meta">
                {t?.('row.tokenExpiry', { time: formatDateTime(account.expiresAt) })
                  ?? `token ${formatDateTime(account.expiresAt)}`}
              </span>
            : null}
          {isCooling && cooldownUntil !== undefined && !Number.isNaN(cooldownUntil)
            ? <span className="dsm-workbuddy-xdpool-account-meta">
                {t?.('row.cooldownUntil', { time: formatTime(cooldownUntil) }) ?? `until ${formatTime(cooldownUntil)}`}
                {' · '}
                {t?.('row.cooldownHits', { hits: account.rateLimitHits ?? 0 })
                  ?? `${account.rateLimitHits ?? 0} hit(s)`}
              </span>
            : null}
          {isDead
            ? <span className="dsm-workbuddy-xdpool-account-meta dsm-workbuddy-xdpool-account-meta-dead">
                {t?.('row.credentialDeadHint') ?? 'Sign in again in the WorkBuddy desktop app to restore it'}
              </span>
            : null}
          {modelCooldowns.length > 0
            ? <div className="dsm-workbuddy-xdpool-account-modelcool">
                {modelCooldowns.map(mc => {
                  // Each row of a product line is rate-limited on its own, so a
                  // cooling free row usually has a paid twin that still serves.
                  // Saying so here turns "wait until 10:14" into a choice.
                  const coolingModel = models.find(model => model.id === mc.modelId)
                  const twin = coolingModel === undefined
                    ? undefined
                    : paidAlternativeFor(coolingModel, models)
                  return (
                    <span key={mc.modelId} className="dsm-workbuddy-xdpool-account-modelcool-chip">
                      {t?.('row.modelCooling', { model: mc.modelId, time: formatDateTime(mc.until) })
                        ?? `${mc.modelId} cooling to ${formatDateTime(mc.until)}`}
                      {twin === undefined ? null
                        : <span className="dsm-workbuddy-xdpool-account-modelcool-twin" title={t?.('row.paidTwinHint') ?? 'Same model, paid row'}>
                            {t?.('row.rateLimitedPaidTwin', { id: twin.id, rate: twin.multiplier.toFixed(2) })
                              ?? `→ ${twin.id} (${twin.multiplier.toFixed(2)}x) still works`}
                          </span>}
                    </span>
                  )
                })}
              </div>
            : null}
        </div>
        <AccountStats
          account={account}
          t={t}
          checkinBusy={checkinBusyId === account.id}
          onClaim={onClaimCheckin}
        />
        {/* Reserved credits: keep the last N credits of an account rather than
            spending it to zero. The pool stops picking the account once its
            balance reaches the floor. */}
        <CreditReserveRow
          account={account}
          t={t}
          busy={reserveBusyId === account.id}
          onSave={onSaveCreditReserve}
        />
        {/* What the automation got this account today, one line per source.
            Nothing is rendered when the automation earned nothing, rather than a
            row of zeroes that reads like a failure. */}
        {account.automationToday === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-earned">
              <span className="dsm-workbuddy-xdpool-earned-label">
                {t?.('row.autoEarned') ?? 'Automation today'}
              </span>
              <span className="dsm-workbuddy-xdpool-earned-list">
                {account.automationToday.credit > 0
                  ? <span className="dsm-workbuddy-xdpool-earned-row">
                      {t?.('row.autoFromTasks', { credit: account.automationToday.credit, energy: account.automationToday.energy, count: account.automationToday.claimed })
                        ?? `Tasks +${account.automationToday.credit}`}
                    </span>
                  : null}
                {account.automationToday.checkinCredit > 0
                  ? <span className="dsm-workbuddy-xdpool-earned-row">
                      {t?.('row.autoFromCheckin', { credit: account.automationToday.checkinCredit })
                        ?? `Check-in +${account.automationToday.checkinCredit}`}
                    </span>
                  : null}
                {account.automationToday.bonusCredit > 0
                  ? <span className="dsm-workbuddy-xdpool-earned-row">
                      {t?.('row.autoFromBonus', { credit: account.automationToday.bonusCredit })
                        ?? `Streak +${account.automationToday.bonusCredit}`}
                    </span>
                  : null}
                {account.automationToday.travelCredit > 0
                  ? <span className="dsm-workbuddy-xdpool-earned-row">
                      {t?.('row.autoFromTravel', { credit: account.automationToday.travelCredit })
                        ?? `Buddy +${account.automationToday.travelCredit}`}
                    </span>
                  : null}
              </span>
            </div>}
      </div>
    </div>
  )
}

/**
 * Daily check-in block: streak summary plus one claim button for this account.
 * Every account in the pool gets its own button, so a multi-account user can
 * collect each reward without switching the pool's preferred account first.
 */
/**
 * Credit panels: package breakdown on the left, the big total on the right with
 * the daily check-in action docked beneath it. Mirrors the two-column credit
 * layout the LaoDing plugin family uses, so the numbers stay scannable and the
 * claim button sits where the eye already is.
 */
/**
 * Reserved-credit control for one account.
 *
 * The value is committed on blur or Enter rather than on every keystroke:
 * each save is a settings write plus a status refresh, and a per-character
 * save would hammer both.
 */
/**
 * The reserved-credit floor for one account.
 *
 * Saving is an EXPLICIT action, not a blur side effect. The old version
 * committed `onBlur`, which meant a value could be written without the user
 * asking for it — and when the write silently failed, the only trace was a
 * notice line at the top of the card that is easy to miss. That is how
 * "I typed a number, reopened, and it says 0 again" happened with no visible
 * error to explain it.
 *
 * Now: the field is a draft, Save is enabled only when the draft differs from
 * what the host last reported, and the outcome (saving / saved / failed) is
 * shown inline next to the button. Enter also saves, so keyboard flow is not
 * lost.
 */
function CreditReserveRow({
  account,
  t,
  busy,
  onSave,
}: {
  account: PoolWebAccount
  t?: PoolCardProps['t']
  busy: boolean
  /** Resolves true when the host confirmed the write, false otherwise. */
  onSave: (accountId: string, reserve: number) => Promise<boolean>
}) {
  const saved = account.creditReserve ?? 0
  const [draft, setDraft] = useState<string>(String(saved))
  // Track the last successful write so the field can settle on it without
  // waiting for the next poll: a save that worked must be visibly reflected.
  const [settled, setSettled] = useState<number>(saved)
  const [note, setNote] = useState<'saved' | 'failed' | undefined>(undefined)

  // Follow the host document when it changes underneath us (another tab, or a
  // refresh after this card saved). Never during an edit: that would overwrite
  // what the user is typing.
  useEffect(() => {
    setSettled(saved)
    setDraft(current => (current === String(saved) ? current : String(saved)))
  }, [saved])

  const parsed = Number.parseInt(draft, 10)
  const next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  // "Dirty" compares against the settled value, not the possibly-stale prop, so
  // the button stays disabled right after a successful save.
  const dirty = next !== settled

  const commit = async (): Promise<void> => {
    if (busy || !dirty) return
    setNote(undefined)
    const ok = await onSave(account.id, next)
    if (ok) {
      setSettled(next)
      setDraft(String(next))
      setNote('saved')
    } else {
      setNote('failed')
    }
  }

  return (
    <div className="dsm-workbuddy-xdpool-reserve">
      <span className="dsm-workbuddy-xdpool-reserve-label">
        {t?.('row.reserveTitle') ?? 'Keep at least'}
      </span>
      <input
        type="number"
        min={0}
        step={1}
        value={draft}
        disabled={busy}
        className="dsm-workbuddy-xdpool-reserve-input"
        aria-label={t?.('row.reserveTitle') ?? 'Keep at least'}
        onChange={(event) => {
          setDraft(event.target.value)
          setNote(undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
        }}
      />
      <span className="dsm-workbuddy-xdpool-reserve-unit">
        {t?.('row.reserveUnit') ?? 'credits'}
      </span>
      <button
        type="button"
        className="dsm-workbuddy-xdpool-reserve-save"
        disabled={busy || !dirty}
        onClick={() => { void commit() }}
      >
        {busy
          ? (t?.('row.reserveSaving') ?? 'Saving…')
          : (t?.('row.reserveSave') ?? 'Save')}
      </button>
      {note === 'saved'
        ? <span className="dsm-workbuddy-xdpool-reserve-note dsm-workbuddy-xdpool-reserve-note-ok">
            {next > 0
              ? (t?.('row.reserveSaved', { credits: next }) ?? `Keeping ${next} credits`)
              : (t?.('row.reserveCleared') ?? 'Reserve cleared')}
          </span>
        : null}
      {note === 'failed'
        ? <span className="dsm-workbuddy-xdpool-reserve-note dsm-workbuddy-xdpool-reserve-note-bad">
            {t?.('row.reserveFailed') ?? 'Not saved — try again'}
          </span>
        : null}
      {account.reserved === true
        ? <span className="dsm-workbuddy-xdpool-reserve-badge">
            {t?.('row.reserveHolding') ?? 'Reserved: skipped'}
          </span>
        : null}
    </div>
  )
}

function AccountStats({
  account,
  t,
  checkinBusy,
  onClaim,
}: {
  account: PoolWebAccount
  t?: PoolCardProps['t']
  checkinBusy: boolean
  onClaim: (accountId: string) => void
}) {
  const credits = account.credits
  const checkin = account.checkin
  const hasCredits = credits !== undefined || account.creditsError !== undefined
  const hasCheckin = checkin !== undefined || account.checkinError !== undefined
  if (!hasCredits && !hasCheckin) return null

  const packages = (credits?.packages ?? [])
    .filter(p => (p.size ?? 0) > 0)
    .slice(0, 6)

  return (
    <div className="dsm-workbuddy-xdpool-stats">
      <section className="dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-packages">
        <span className="dsm-workbuddy-xdpool-panel-title">
          {t?.('row.creditsPackages') ?? 'Credit packages'}
        </span>
        {account.creditsError !== undefined
          // The upstream error is a full English paragraph (it explains HOW to
          // recover). Printed inline it blew the panel up to several lines and
          // pushed "Total" off screen, so the panel shows a short marker and the
          // full text lives in the tooltip / title attribute.
          ? <span
              className={`dsm-workbuddy-xdpool-panel-error${account.credentialDead === true ? ' dsm-workbuddy-xdpool-panel-error-dead' : ''}`}
              title={account.creditsError}
            >
              {account.credentialDead === true
                ? t?.('row.credentialDead') ?? 'Sign-in rejected'
                : t?.('row.creditsError') ?? 'credits unavailable'}
            </span>
          : packages.length === 0
            ? <span className="dsm-workbuddy-xdpool-panel-empty">–</span>
            : <ul className="dsm-workbuddy-xdpool-packages">
                {packages.map((pack, index) => {
                  const expiry = formatExpiry(pack.expiresAtMs)
                  const refresh = formatExpiry(pack.cycleRefreshMs)
                  const soon = isExpiringSoon(pack)
                  // Monthly packs refresh on a cycle; one-off packs expire. Either
                  // way the deadline is what the user needs, and a pack that declares
                  // neither simply omits the line (the grid keeps the columns aligned).
                  const when = pack.monthly === true
                    ? (refresh === '' ? null : (t?.('row.creditsRefreshAt', { time: refresh }) ?? `Refreshes ${refresh}`))
                    : (expiry === '' ? null : (t?.('row.creditsExpiresAt', { time: expiry }) ?? `Expires ${expiry}`))
                  return (
                    <li key={`${pack.packageName}-${String(index)}`}>
                      <span className="dsm-workbuddy-xdpool-packages-name">{pack.packageName}</span>
                      <span className="dsm-workbuddy-xdpool-packages-value">
                        {t?.('row.creditsPackage', { remain: formatNumber(pack.remain), size: formatNumber(pack.size) })
                          ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`}
                      </span>
                      {when === null ? null
                        : <span
                            className={`dsm-workbuddy-xdpool-packages-when${soon ? ' dsm-workbuddy-xdpool-packages-when-soon' : ''}`}
                            title={t?.('row.creditsExpiresSoonTitle') ?? 'Expiring within 3 days'}
                          >
                            {when}
                          </span>}
                    </li>
                  )
                })}
              </ul>}
        {credits?.expiringSoon !== undefined && credits.expiringSoon > 0
          ? <div className="dsm-workbuddy-xdpool-panel-foot">
              <span>{t?.('row.creditsSoon') ?? 'Expiring in 3 days'}</span>
              <strong>{formatNumber(credits.expiringSoon)}</strong>
            </div>
          : null}
      </section>

      <section className="dsm-workbuddy-xdpool-panel dsm-workbuddy-xdpool-panel-total">
        <span className="dsm-workbuddy-xdpool-panel-title">
          {t?.('row.creditsTotal') ?? 'Total'}
        </span>
        <span className="dsm-workbuddy-xdpool-total-value">
          {formatNumber(credits?.total)}
        </span>
        {hasCheckin
          ? <div className="dsm-workbuddy-xdpool-checkin">
              {account.checkinError !== undefined
                /* Folded to a marker with the full text in the tooltip, exactly
                   like the credits error above. A gateway rejection is a whole
                   paragraph; printed inline it buries the panel it belongs to. */
                ? <span className="dsm-workbuddy-xdpool-checkin-error" title={account.checkinError}>
                    {t?.('row.checkinUnavailable') ?? 'check-in unavailable'}
                  </span>
                : checkin === undefined
                  ? null
                  : <>
                      <div className="dsm-workbuddy-xdpool-checkin-meta">
                        <span className="dsm-workbuddy-xdpool-checkin-streak">
                          {t?.('row.checkinStreak', { days: checkin.streakDays })
                            ?? `${checkin.streakDays}-day streak`}
                        </span>
                        {checkin.dailyCredit > 0
                          ? <span className="dsm-workbuddy-xdpool-checkin-daily">
                              {t?.('row.checkinDaily', { credit: formatNumber(checkin.dailyCredit) })
                                ?? `+${formatNumber(checkin.dailyCredit)}/day`}
                            </span>
                          : null}
                      </div>
                      {checkin.isStreakDay && checkin.streakBonusCredit > 0
                        ? <span className="dsm-workbuddy-xdpool-checkin-bonus">
                            {t?.('row.checkinStreakBonus', {
                              days: formatNumber(checkin.nextStreakDay),
                              credit: formatNumber(checkin.streakBonusCredit),
                            }) ?? `bonus +${formatNumber(checkin.streakBonusCredit)}`}
                          </span>
                        : null}
                      <button
                        type="button"
                        className="dsm-workbuddy-xdpool-checkin-btn"
                        disabled={!checkin.active || checkin.todayCheckedIn || checkinBusy}
                        onClick={() => { onClaim(account.id) }}
                      >
                        {!checkin.active
                          ? (t?.('row.checkinInactive') ?? 'Unavailable')
                          : checkin.todayCheckedIn
                            ? (t?.('row.checkinClaimed') ?? 'Checked in')
                            : checkinBusy
                              ? (t?.('row.checkinClaiming') ?? 'Checking in…')
                              : (t?.('row.checkinClaim') ?? 'Check in')}
                      </button>
                    </>}
            </div>
          : null}
      </section>
    </div>
  )
}

/**
 * One model row.
 *
 * Read-only when the card has no writable settings scope: the checkbox and the
 * context radios stay disabled rather than pretending an edit took hold. The
 * draft lives in the parent, so this component only ever reports intent.
 */
function ModelRow({
  model,
  region,
  paidTwin,
  t,
  draft,
  editable,
  onToggle,
  onToggleImage,
  onBudget,
}: {
  model: PoolWebModel
  /** Which gateway this row belongs to; the promo campaigns are regional. */
  region: 'cn' | 'global'
  /**
   * The cheapest priced row sharing this model's display name, when this row
   * itself is free. Undefined for paid rows and for lone models — see
   * {@link paidAlternativeFor} for why the guard matters.
   */
  paidTwin: PaidSibling | undefined
  t?: PoolCardProps['t']
  draft: ModelDraftEntry
  editable: boolean
  onToggle: (id: string) => void
  onToggleImage: (id: string) => void
  onBudget: (id: string, budget: number) => void
}) {
  const now = new Date()
  const tag = tagFor(model, now, region)
  const promo = promoStatusFor(model, now, region)
  const tagText = tag === 'free'
    ? (t?.('row.free') ?? 'free')
    : tag === 'limited'
      ? (t?.('row.limitedFree') ?? 'limited free')
      : tag === 'night'
        ? (t?.('row.nightFreeNow', { time: `${String(promo?.kind === 'night' ? promo.untilHour : 0).padStart(2, '0')}:00` })
            ?? 'free until 08:00')
        : null
  /**
   * The "cheaper later" hint: the model is on a promotion but the window is
   * closed. Deliberately NOT a "free" badge — it costs credits at this moment,
   * and telling the user otherwise would change what they spend.
   */
  const laterHint = promo?.kind === 'night-later'
    ? (t?.('row.nightFreeLater', { time: `${String(promo.nextHour).padStart(2, '0')}:00` })
        ?? `free from ${String(promo.nextHour).padStart(2, '0')}:00`)
    : null
  /**
   * How long the campaign itself runs, e.g. "活动至 10-31".
   *
   * Shown on both the free and the not-yet-free row, because the useful question
   * is not only "is it free now" but "until when is this offer good at all" —
   * an extension changes that date, and a user planning around the promotion
   * needs it visible rather than buried in a changelog.
   */
  const promoUntil = promo === undefined || promo.kind === 'free'
    ? null
    : (t?.('row.promoUntil', { date: promo.promoUntil.slice(5).replace('-', '-') })
        ?? `promo until ${promo.promoUntil}`)

  const native = model.nativeContextWindow
  const capped = native > DEFAULT_CONTEXT_BUDGET
  const currentBudget = draft.budget ?? native

  return (
    <div className={`dsm-workbuddy-xdpool-model${draft.enabled ? '' : ' dsm-workbuddy-xdpool-model-off'}`}>
      <div className="dsm-workbuddy-xdpool-model-head">
        <label className="dsm-workbuddy-xdpool-model-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!editable}
            onChange={() => { onToggle(model.id) }}
          />
          <span className="dsm-workbuddy-xdpool-model-copy">
            <span className="dsm-workbuddy-xdpool-model-name">
              <span>{model.name}</span>
              {/* A zero multiplier IS the upstream's way of saying "free"
                  (`credits: "x0.00"`), so printing "x0.00 积分" next to a
                  model that costs nothing is worse than printing nothing.
                  The badge below already carries the free/free-tier label. */}
              {model.multiplier === undefined || model.multiplier === 0 ? null
                : <span className="dsm-workbuddy-xdpool-model-name-rate">
                    {t?.('row.rate', { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`}
                  </span>}
            </span>
            <span className="dsm-workbuddy-xdpool-model-id">{model.id}</span>
          </span>
        </label>
        <div className="dsm-workbuddy-xdpool-model-controls">
          <label className="dsm-workbuddy-xdpool-model-image" title={t?.('row.modelImage') ?? 'Image input'}>
            <input
              type="checkbox"
              checked={draft.images}
              disabled={!editable}
              onChange={() => { onToggleImage(model.id) }}
            />
            <span>{t?.('row.modelImage') ?? 'Image'}</span>
          </label>
          {capped
            ? <fieldset className="dsm-workbuddy-xdpool-model-budget" aria-label={t?.('row.modelContextBudget') ?? 'Context'}>
                <label>
                  <input
                    type="radio"
                    name={`budget-${model.id}`}
                    checked={currentBudget === DEFAULT_CONTEXT_BUDGET}
                    disabled={!editable}
                    onChange={() => { onBudget(model.id, DEFAULT_CONTEXT_BUDGET) }}
                  />
                  <span>{formatCapacity(DEFAULT_CONTEXT_BUDGET)}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`budget-${model.id}`}
                    checked={currentBudget === native}
                    disabled={!editable}
                    onChange={() => { onBudget(model.id, native) }}
                  />
                  <span>{formatCapacity(native)}</span>
                </label>
              </fieldset>
            : null}
        </div>
      </div>
      <div className="dsm-workbuddy-xdpool-model-meta">
        {tagText === null ? null
          : <span className="dsm-workbuddy-xdpool-model-meta-tag">{tagText}</span>}
        {laterHint === null ? null
          : <span className="dsm-workbuddy-xdpool-model-meta-later">{laterHint}</span>}
        {promoUntil === null ? null
          : <span className="dsm-workbuddy-xdpool-model-meta-promo">{promoUntil}</span>}
        {paidTwin === undefined ? null
          : <span className="dsm-workbuddy-xdpool-model-meta-twin" title={t?.('row.paidTwinHint') ?? 'Same model, paid row'}>
              {t?.('row.paidTwin', { id: paidTwin.id, rate: paidTwin.multiplier.toFixed(2) })
                ?? `paid twin ${paidTwin.id} (${paidTwin.multiplier.toFixed(2)}x)`}
            </span>}
        <span className="dsm-workbuddy-xdpool-model-cap">
          {t?.('row.modelOutput', { size: formatCapacity(model.maxOutputTokens) })
            ?? `out ${formatCapacity(model.maxOutputTokens)}`}
        </span>
        {model.supportedEfforts === undefined || model.supportedEfforts.length === 0 ? null
          : <span className="dsm-workbuddy-xdpool-model-cap">
              {t?.('row.modelReasoning', { efforts: model.supportedEfforts.join(' / ') })
                ?? model.supportedEfforts.join(' / ')}
            </span>}
      </div>
    </div>
  )
}
