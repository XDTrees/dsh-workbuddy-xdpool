/**
 * WorkBuddy XD Pool page contributed to the DSH Plugin configuration.
 *
 * Layout, in one screen:
 *
 *   1. a header strip — identity plus the two global actions;
 *   2. a toolbar — region switch, health, usage mode;
 *   3. an automation strip (domestic region only);
 *   4. two columns — compact account rows on the left, compact model rows on
 *      the right.
 *
 * Everything that used to be rendered inline per row (credit packages,
 * check-in, reserved credits, per-model usage, the full model configuration)
 * now lives in a dialog opened by clicking the row. That is what keeps the page
 * inside one screen; see `styles.ts` for the visual contract.
 *
 * @module dsh-workbuddy-xdpool/client/PoolCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
  type PoolWebUsageSummary,
  type PoolRegion,
  type PoolWebCreditPackage,
  type PoolWebCredits,
  type PoolDistribution,
} from '../status-paths.ts'
import { DEFAULT_AUTOMATION_HOURS } from '../status-paths.ts'
import { POOL_PLUGIN_ICON } from './icon.ts'
import { POOL_CARD_CSS } from './styles.ts'
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

/**
 * The two gateways, in display order.
 *
 * A module constant rather than a field of the status document: the tab strip
 * must render even when no document has arrived, and must not vanish when the
 * active region's document is missing.
 */
const POOL_REGIONS: readonly PoolRegion[] = ['cn', 'global']

/** The region a tab switch lands on. */
function otherRegion(region: PoolRegion): PoolRegion {
  return region === 'cn' ? 'global' : 'cn'
}

/** Inject or refresh the shared page CSS for the current client bundle. */
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

/**
 * Split an account label into its display name and its discriminator.
 *
 * Labels are built as `name#uidprefix` (see `accountLabel` on the host) so two
 * accounts sharing a nickname stay apart. The discriminator is an identifier,
 * not something to read at a glance, so the row shows the name alone and the
 * dialog keeps the full label where the detail belongs.
 */
function splitLabel(label: string): { name: string; discriminator?: string } {
  const cut = label.lastIndexOf('#')
  if (cut <= 0) return { name: label }
  const discriminator = label.slice(cut + 1)
  if (discriminator === '') return { name: label }
  return { name: label.slice(0, cut), discriminator }
}

/**
 * The display name for an account id, as the account list shows it.
 *
 * The usage ledger outlives an account's presence in the pool — an account
 * removed since it served a request still has rows — so an unresolved id falls
 * back to the id itself rather than vanishing from the breakdown.
 */
function accountLabelOf(status: PoolWebStatus, accountId: string): string {
  const account = status.accounts.find(entry => entry.id === accountId)
  if (account === undefined) return accountId
  const { name } = splitLabel(account.label)
  return name
}

/** Localized name for a region key in the usage breakdown. */
function regionLabelOf(key: string, t?: PoolCardProps['t']): string {
  if (key === 'cn') return t?.('row.tabCn') ?? 'cn'
  if (key === 'global') return t?.('row.tabGlobal') ?? 'global'
  return key
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

/** How long to watch a manual run before giving up on it. */
const AUTOMATION_POLL_MS = 2000
const AUTOMATION_POLL_ATTEMPTS = 90

// The page renders one row per kind, and the list must match the scheduler's
// `AUTOMATION_JOB_KINDS` exactly — they are two hand-written lists that have to
// agree, and a kind missing here is invisible (the job runs, nothing shows it).
export const AUTOMATION_JOBS = ['checkin', 'report', 'tasks', 'streak', 'travel'] as const

export type AutomationJobKind = typeof AUTOMATION_JOBS[number]

/**
 * The hour list to save for one job: what the card holds, or the default.
 *
 * Mirrors the host's own fallback (`hoursOrDefault` in `scheduler.ts`). An
 * empty list must resolve to the default on BOTH sides, or the card would save
 * a schedule the scheduler then refuses to run.
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

/** One model's draft state while the page holds unsaved edits. */
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

/** Absolute expiry with the time of day: one-off packs lapse at arbitrary times. */
function formatExpiry(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

/**
 * Whole days until `ms`, floored at 0; undefined when there is no deadline.
 */
function daysUntil(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.max(0, Math.floor((ms - Date.now()) / 86_400_000))
}

/**
 * The batch of credits that runs out first, and when.
 *
 * Credits do not expire as one lump. A daily check-in adds a batch that lapses
 * on its own clock, a gift adds a batch with its own deadline, and the balance
 * is the sum — so "2000 credits" can mean "1000 gone in three days". Summing is
 * what the plain total does; this finds the FIRST batch to go, which is the
 * number that decides whether any of it gets spent in time.
 *
 * Built from the one-off packages only. A monthly package has no expiry at all
 * (it refreshes on a cycle), so counting it would invent a deadline; packages
 * already empty or already past are skipped for the same reason.
 *
 * Ties are summed: two batches lapsing at the same moment are one event as far
 * as the user is concerned.
 */
function oldestExpiringBatch(
  credits: PoolWebCredits | undefined,
): { remain: number; expiresAtMs: number; days: number } | undefined {
  const dated = (credits?.packages ?? [])
    .filter(pack => pack.monthly !== true)
    .filter(pack => (pack.remain ?? 0) > 0)
    .filter(pack => pack.expiresAtMs !== undefined && Number.isFinite(pack.expiresAtMs))
    .filter(pack => (pack.expiresAtMs ?? 0) > Date.now())
  if (dated.length === 0) return undefined
  const soonest = Math.min(...dated.map(pack => pack.expiresAtMs as number))
  const remain = dated
    .filter(pack => pack.expiresAtMs === soonest)
    .reduce((sum, pack) => sum + (pack.remain ?? 0), 0)
  return { remain, expiresAtMs: soonest, days: daysUntil(soonest) ?? 0 }
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
 * `free` is read off the CREDIT MULTIPLIER, not off a tag. Neither gateway ever
 * sends a literal `free` tag: the global roster marks its zero-cost models as
 * `credits: "x0.00"`, so waiting for a tag meant the badge NEVER appeared.
 * An explicit free-ish tag still wins when present.
 */
function tagFor(model: PoolWebModel): 'free' | 'limited' | 'night' | undefined {
  const tags = model.tags ?? []
  if (tags.includes('free') || model.multiplier === 0) return 'free'
  if (tags.includes('limited-free')) return 'limited'
  if (tags.includes('night-discount')) return 'night'
  return undefined
}

/** Render the pool health, account list, model list and their dialogs. */
export function PoolCard({ t, settingsScope }: PoolCardProps) {
  // The slot tells us whether the settings document is writable; a
  // read-only scope (locked profile) renders the model rows disabled.
  const settingsWritable = settingsScope?.getSnapshot().writable === true
  /** Which region tab is showing. A CN-only install never leaves this. */
  const [activeRegion, setActiveRegion] = useState<'cn' | 'global'>('cn')
  /** Last-known status per region, so a tab switch shows real content at once. */
  const [statusByRegion, setStatusByRegion] = useState<
    Partial<Record<PoolRegion, PoolWebStatus>>
  >({})

  /** The document for the tab on screen; undefined until its first answer. */
  const status = statusByRegion[activeRegion]
  /**
   * Today's automation take, summed across accounts.
   *
   * Summed from the per-account counters rather than kept separately, so the
   * strip total and the per-account lines can never disagree.
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
  /** Last error per region: one gateway failing must not paint the other broken. */
  const [errorByRegion, setErrorByRegion] = useState<Partial<Record<PoolRegion, string | undefined>>>({})
  const [busy, setBusy] = useState(false)
  const [cooldownBusy, setCooldownBusy] = useState(false)
  /** Model-catalog refresh in flight (separate from the account rescan). */
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [automationBusy, setAutomationBusy] = useState(false)
  /** The automation run currently being watched from the page, if any. */
  const [automationRun, setAutomationRun] = useState<AutomationJobKind | 'all' | undefined>(undefined)
  /** Account id whose reserved-credit floor is being saved, if any. */
  const [reserveBusy, setReserveBusy] = useState<string | undefined>(undefined)
  const [flash, setFlash] = useState<string | undefined>(undefined)
  /** Account id whose daily claim is currently in flight. */
  const [checkinBusyId, setCheckinBusyId] = useState<string | undefined>(undefined)
  /** Account id whose enable/disable switch is in flight, if any. */
  const [accountBusyId, setAccountBusyId] = useState<string | undefined>(undefined)
  /** Which dialog is open, if any. */
  const [dialog, setDialog] = useState<'accounts' | 'models' | undefined>(undefined)
  /** The account whose detail dialog is open, by id. */
  const [openAccountId, setOpenAccountId] = useState<string | undefined>(undefined)
  /** How-to-sign-in disclosure inside the empty state. */
  const [howToOpen, setHowToOpen] = useState(false)
  /** Automation schedule dialog. */
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /**
   * Draft model selection. `undefined` means "no local edits"; once a checkbox
   * is touched the draft takes over and is what the Save button posts.
   */
  const [draftByRegion, setDraftByRegion] = useState<Partial<Record<PoolRegion, Record<string, ModelDraftEntry>>>>({})
  /** The draft for the tab on screen, keyed by region so edits cannot leak across. */
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
   * effect can key off it without restarting on every switch.
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
        setErrorByRegion(prev => ({ ...prev, [region]: undefined }))
      }
      // Returned so a caller that needs to poll a field (the automation run
      // state) can read the fresh value instead of a stale render.
      return value as PoolWebStatus
    } catch (cause: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        // Recorded against THIS region. A single shared error slot painted one
        // gateway's failure onto the other gateway's tab.
        setErrorByRegion(prev => ({ ...prev, [region]: cause instanceof Error ? cause.message : String(cause) }))
      }
      return undefined
    }
  }, [])

  /**
   * Read the region on screen, on mount and on every switch.
   *
   * No abort signal is passed, deliberately: a request for the region the user
   * just left is still the freshest answer for THAT region's slot.
   */
  useEffect(() => {
    void refresh(activeRegion)
  }, [refresh, activeRegion])

  /**
   * Warm the OTHER region once, at mount, so a tab switch paints real content
   * instead of a spinner. Deliberately NOT repeated on the poll interval —
   * every status document costs one upstream probe per account.
   */
  const activeRegionRef = useRef(activeRegion)
  activeRegionRef.current = activeRegion
  useEffect(() => {
    void refresh(otherRegion(activeRegionRef.current))
  }, [refresh])

  /**
   * One long-lived poll of the ACTIVE region.
   *
   * `activeRegion` is deliberately absent from the dependency list, and the
   * controller is not aborted on a switch: tearing down the in-flight request
   * on every tab click left BOTH regions with no document at all when the user
   * clicked faster than the host could answer.
   */
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void refresh(activeRegionRef.current, controller.signal)
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [refresh])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    setFlash(undefined)
    setError(undefined)
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
   * Its own action because the account rescan could not do this job: when the
   * startup fetch failed, the picker held the shorter built-in list and
   * "detect again" left it untouched, so the only recovery was restarting DSH.
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
    setError(undefined)
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
   * collect account B's reward.
   */
  const claimCheckin = async (accountId: string): Promise<void> => {
    setCheckinBusyId(accountId)
    setFlash(undefined)
    setError(undefined)
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
   * Disabling only stops the account from being picked — it stays listed so it
   * can be turned back on — and the change is saved through the settings
   * section, so it survives a restart and is re-applied after every re-scan.
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
    setError(undefined)
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
   * scope is involved, which is also why it works on a read-only profile.
   */
  const setAccountIgnored = async (accountId: string, ignored: boolean): Promise<void> => {
    setAccountBusyId(accountId)
    setFlash(undefined)
    setError(undefined)
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
      if (ignored && openAccountId === accountId) setOpenAccountId(undefined)
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
   * The models the pool will actually serve, in catalog order.
   *
   * Read off the DRAFT rather than off `model.enabled`, so unchecking a model
   * removes its row immediately instead of at the next poll.
   */
  const enabledModels = (status?.models ?? [])
    .filter(model => (modelDraft[model.id] ?? { enabled: model.enabled }).enabled)

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
    setError(undefined)
  }

  /**
   * Switch how the pool spreads requests. Written straight through the
   * settings scope (that is where the host keeps the pool options), so the
   * change lands without a restart and survives the next refresh.
   */
  const setDistribution = async (next: PoolDistribution): Promise<void> => {
    const write = settingsScope?.set
    if (write === undefined) {
      setError(t?.('row.modelsSaveError', { message: 'settings scope is read-only' })
        ?? 'settings scope is read-only')
      return
    }
    setFlash(undefined)
    setError(undefined)
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
    setError(undefined)
    try {
      // Every schedule field is carried along, `travelHours` included: it used
      // to be missing from this list, so toggling the switch silently DROPPED
      // the travel schedule from the saved document.
      //
      // Each list also falls back to the same defaults the host uses when it is
      // empty, so a document already holding `[]` is healed by the next toggle.
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
   * Run the whole automation pass now.
   *
   * The route only STARTS the pass: a full run takes tens of seconds, which is
   * far too long to hold a request open. This watches the scheduler status until
   * the run settles, so the button can show "running" honestly.
   */
  const runAutomationJob = async (): Promise<void> => {
    setAutomationRun('all')
    setFlash(undefined)
    setError(undefined)
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
   * A reserve only protects credits if the pool knows the balance, so this also
   * refreshes the account list afterwards: the reserve badge appears as soon as
   * the reading crosses the floor.
   *
   * Returns whether the host CONFIRMED the write. The dialog keys its inline
   * "saved / not saved" note off this, so a failure is shown where the user is
   * looking instead of only in the page-level notice line.
   */
  const saveCreditReserve = async (accountId: string, reserve: number): Promise<boolean> => {
    setReserveBusy(accountId)
    setFlash(undefined)
    setError(undefined)
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
      // Reported to the caller (inline note) AND to the page-level error line:
      // the inline note says what failed, the line says why.
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mounted.current) setReserveBusy(undefined)
    }
  }

  /**
   * Persist the model draft into the plugin settings section.
   *
   * The write goes through `settingsScope` rather than a bespoke route: that is
   * the same document the model picker reads, so one save covers every account
   * and survives account rotation — the selection is a property of the pool,
   * not of whichever account happens to be serving right now.
   */
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
    setError(undefined)
    try {
      // Every id the catalog knows about, so a model added upstream while the
      // page sat open is not silently dropped by an unrelated save.
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
  /** This region's own failure, which is what its tab and body should report. */
  const regionError = errorByRegion[activeRegion]
  /**
   * The active region has no document yet AND no failure. That is a distinct
   * state from "this region has no accounts": with no document we do not know
   * the account list, so claiming emptiness sends the user off to re-sign-in to
   * an account that is already in the pool.
   */
  const loading = status === undefined && regionError === undefined
  const hasHealthy = accountCount > 0 && cooling < accountCount
  const state: 'ok' | 'error' | 'idle' = regionError !== undefined
    ? 'error'
    : (loading ? 'idle' : (hasHealthy ? 'ok' : 'idle'))
  /** One region's dot state, for the tab strip (each dot reports its own). */
  const regionState = (region: PoolRegion): 'ok' | 'error' | 'idle' => {
    if (errorByRegion[region] !== undefined) return 'error'
    const doc = statusByRegion[region]
    if (doc === undefined) return 'idle'
    const total = doc.accounts.length
    return total > 0 && doc.cooling < total ? 'ok' : 'idle'
  }
  /** Human label for the active tab, used inside the empty-state copy. */
  const regionLabel = activeRegion === 'cn'
    ? (t?.('row.tabCn') ?? 'CN')
    : (t?.('row.tabGlobal') ?? 'Global')

  const stateLabel = regionError !== undefined
    ? (t?.('row.requestFailed') ?? 'Request failed')
    : loading
      ? (t?.('row.regionLoading') ?? 'Loading…')
      : accountCount === 0
        ? (t?.('row.regionEmpty') ?? 'No account signed in')
        : state === 'ok'
          ? (t?.('row.ok') ?? 'Healthy')
          : (t?.('row.allCooling') ?? 'All cooling')
  const shimRunning = status?.shim.running === true
  const shimHint = status === undefined
    ? null
    : shimRunning
      ? `${t?.('row.shimRunning') ?? 'Loopback ready'}${status.shim.baseUrl === undefined ? '' : ` ${status.shim.baseUrl}`}`
      : (t?.('row.shimStopped') ?? 'Loopback not running')

  const accountSummary = cooling > 0
    ? (t?.('row.accountsSummaryCooling', { count: accountCount, cooling })
        ?? `${accountCount} accounts · ${cooling} cooling`)
    : (t?.('row.accountsSummary', { count: accountCount }) ?? `${accountCount} accounts`)

  /** The account whose dialog is open, resolved fresh so it tracks polls. */
  const openAccount = openAccountId === undefined
    ? undefined
    : status?.accounts.find(account => account.id === openAccountId)

  /**
   * The account list in PICK ORDER, each entry carrying its 1-based rank.
   *
   * Under the default `priority` distribution the pool answers from the head of
   * its list until that account is rate-limited, so the rank is the real order
   * and the first entry is the one serving. `round-robin` and `balanced` rotate
   * instead, and the numbers there are only the list's own order.
   *
   * Enabled accounts come first because the host's order is credential
   * freshness: a disabled account would otherwise interleave with the live ones
   * and the numbers would not read as a queue. Disabled entries stay listed,
   * ranked last, so they can be switched back on.
   */
  const rankedAccounts = (() => {
    const accounts = status?.accounts ?? []
    const rows = accounts.map((account, index) => ({ account, index }))
    rows.sort((a, b) => {
      const offA = a.account.disabled === true ? 1 : 0
      const offB = b.account.disabled === true ? 1 : 0
      return offA - offB || a.index - b.index
    })
    return rows.map(({ account }, index) => ({ account, rank: index + 1 }))
  })()

  const automationToday = automationTotals.credit + automationTotals.checkinCredit
    + automationTotals.bonusCredit + automationTotals.travelCredit

  /** Close whichever dialog is open. */
  const closeDialogs = (): void => {
    setDialog(undefined)
    setOpenAccountId(undefined)
  }

  return (
    <section className="dsm-workbuddy-xdpool-page">
      {/* Header: identity plus the two global actions. Nothing else lives here,
          so the buttons are not repeated further down the page. */}
      <header className="dsm-workbuddy-xdpool-head">
        <img className="dsm-workbuddy-xdpool-head-icon" src={POOL_PLUGIN_ICON} alt="" />
        <span className="dsm-workbuddy-xdpool-head-copy">
          <h2 className="dsm-workbuddy-xdpool-head-title">{title}</h2>
          <p className="dsm-workbuddy-xdpool-head-desc">{description}</p>
        </span>
        <div className="dsm-workbuddy-xdpool-head-actions">
          {cooling > 0
            ? <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={cooldownBusy}
                onClick={() => { void resetCooldowns() }}
              >
                {cooldownBusy
                  ? (t?.('row.resetCooldownsBusy') ?? 'Clearing…')
                  : (t?.('row.resetCooldowns') ?? 'Clear cooldowns')}
              </button>
            : null}
          <button
            type="button"
            className="dsm-btn dsm-btn-outline"
            disabled={busy}
            onClick={() => { void rescan() }}
          >
            {busy
              ? (t?.('row.accountsScanning') ?? 'Detecting…')
              : (t?.('row.accountsRescan') ?? 'Detect again')}
          </button>
        </div>
      </header>

      {/* Toolbar: region switch, health, usage mode. One row. */}
      <section className="dsm-workbuddy-xdpool-card">
        <div className="dsm-workbuddy-xdpool-bar">
          {/* The strip iterates the CONSTANT region list, never the active
              region's document. Deriving it from `status.regions` made the whole
              strip disappear the instant the user switched to a region whose
              document had not arrived, stranding them with no way back. */}
          <div className="dsm-workbuddy-xdpool-tabs" role="tablist">
            {POOL_REGIONS.map(region => (
              <button
                key={region}
                type="button"
                role="tab"
                aria-selected={region === activeRegion}
                className={`dsm-workbuddy-xdpool-tab${region === activeRegion ? ' dsm-workbuddy-xdpool-tab-active' : ''}`}
                onClick={() => { setActiveRegion(region); setOpenAccountId(undefined) }}
              >
                {/* Each dot reports its OWN region: one shared `state` painted
                    both dots with the visible tab's health. */}
                <span className="dsm-workbuddy-xdpool-tab-dot" data-state={regionState(region)} />
                {region === 'cn'
                  ? (t?.('row.tabCn') ?? 'CN')
                  : (t?.('row.tabGlobal') ?? 'Global')}
              </button>
            ))}
          </div>

          <div className="dsm-workbuddy-xdpool-health" role="status">
            <span
              aria-hidden="true"
              className="dsm-workbuddy-xdpool-health-dot"
              style={{ background: dotColor(state) }}
            />
            <span className="dsm-workbuddy-xdpool-health-text">{stateLabel}</span>
            {accountCount > 0
              ? <span className="dsm-workbuddy-xdpool-health-meta">{accountSummary}</span>
              : null}
            {shimHint === null
              ? null
              : <span className="dsm-workbuddy-xdpool-health-meta">{shimHint}</span>}
          </div>

          {/* Usage mode. The hint that used to sit inside each button ("use one
              account until it runs out…") is now the title: three sentences of
              explanation were costing a whole row of height. */}
          {status === undefined
            ? null
            : <div
                className="dsm-workbuddy-xdpool-seg"
                role="radiogroup"
                aria-label={t?.('row.distTitle') ?? 'Usage'}
              >
                {(['priority', 'balanced', 'round-robin'] as const).map(option => {
                  const active = (status.distribution ?? 'priority') === option
                  const label = option === 'priority'
                    ? (t?.('row.distPriority') ?? 'Priority')
                    : option === 'balanced'
                      ? (t?.('row.distBalanced') ?? 'Balanced')
                      : (t?.('row.distRoundRobin') ?? 'Round-robin')
                  const hint = option === 'priority'
                    ? (t?.('row.distPriorityHint') ?? '')
                    : option === 'balanced'
                      ? (t?.('row.distBalancedHint') ?? '')
                      : (t?.('row.distRoundRobinHint') ?? '')
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={hint}
                      disabled={!modelsEditable}
                      className={`dsm-workbuddy-xdpool-seg-btn${active ? ' dsm-workbuddy-xdpool-seg-btn-active' : ''}`}
                      onClick={() => { void setDistribution(option) }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>}
        </div>
      </section>

      {/* Automation: one strip. The per-job schedule and last-run table it used
          to print inline now lives in a dialog behind "Schedule". Automation is
          CN-only: the international gateway has no growth/task system at all,
          so showing the switch there would offer a control that does nothing. */}
      {activeRegion !== 'cn' || status?.automation === undefined
        ? null
        : <section className="dsm-workbuddy-xdpool-card">
            <div className="dsm-workbuddy-xdpool-auto">
              <div className="dsm-workbuddy-xdpool-auto-copy">
                <span className="dsm-workbuddy-xdpool-auto-title">
                  {t?.('row.autoTitle') ?? 'Automation'}
                </span>
                <span className="dsm-workbuddy-xdpool-auto-hint">
                  {status.automation.enabled
                    ? (t?.('row.autoHintOn') ?? 'Checks in and claims rewards every day.')
                    : (t?.('row.autoHintOff') ?? 'No background requests.')}
                </span>
              </div>
              {automationToday <= 0
                ? null
                : <span className="dsm-workbuddy-xdpool-auto-income">
                    {t?.('row.autoTodayEarned', { credit: formatNumber(automationToday) })
                      ?? `+${formatNumber(automationToday)} today`}
                  </span>}
              <div className="dsm-workbuddy-xdpool-auto-actions">
                {/* One button for the whole pass rather than one per job: the
                    jobs are ordered and share accounts, so running them one by
                    one is never what the user means. */}
                {!status.automation.enabled
                  ? null
                  : <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={automationRun !== undefined}
                      onClick={() => { void runAutomationJob() }}
                    >
                      {automationRun !== undefined
                        ? (t?.('row.autoRunning') ?? 'Running…')
                        : (t?.('row.autoRunAll') ?? 'Run now')}
                    </button>}
                {!status.automation.enabled
                  ? null
                  : <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      onClick={() => { setScheduleOpen(true) }}
                    >
                      {t?.('row.schedule') ?? 'Schedule'}
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
            </div>
          </section>}

      {flash === undefined ? null : <p className="dsm-workbuddy-xdpool-note">{flash}</p>}
      {/* The region-scoped failure, and then the page-level one for actions
          that are not region-scoped (a failed save or check-in). Both are
          shown: they describe different failures. */}
      {regionError === undefined
        ? null
        : <p className="dsm-workbuddy-xdpool-error">{t?.('row.error', { message: regionError }) ?? regionError}</p>}
      {error === undefined
        ? null
        : <p className="dsm-workbuddy-xdpool-error">{t?.('row.error', { message: error }) ?? error}</p>}

      {loading
        ? <section className="dsm-workbuddy-xdpool-card">
            <p className="dsm-workbuddy-xdpool-col-empty">{t?.('row.regionLoading') ?? 'Loading…'}</p>
          </section>
        : null}

      {/* Empty region. The four-step sign-in walkthrough is the only real
          instruction on the page, so it stays — but behind a disclosure, where
          it costs one line instead of eight. */}
      {accountCount === 0 && regionError === undefined && !loading
        ? <section className="dsm-workbuddy-xdpool-card">
            <div className="dsm-workbuddy-xdpool-auto">
              <div className="dsm-workbuddy-xdpool-auto-copy">
                <span className="dsm-workbuddy-xdpool-auto-title">
                  {t?.('row.regionEmptyTitle', { region: regionLabel })
                    ?? t?.('row.regionEmpty') ?? 'No account yet'}
                </span>
              </div>
              <div className="dsm-workbuddy-xdpool-auto-actions">
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  aria-expanded={howToOpen}
                  onClick={() => { setHowToOpen(v => !v) }}
                >
                  {t?.('row.howTo') ?? 'How to sign in'}
                </button>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-primary"
                  disabled={busy}
                  onClick={() => { void rescan() }}
                >
                  {busy
                    ? (t?.('row.accountsScanning') ?? 'Detecting…')
                    : (t?.('row.accountsRescan') ?? 'Detect again')}
                </button>
              </div>
            </div>
            {!howToOpen
              ? null
              : <div className="dsm-workbuddy-xdpool-howto">
                  <span className="dsm-workbuddy-xdpool-sec-title">
                    {t?.('row.regionHowToTitle', { region: regionLabel })
                      ?? `Signing in to the ${regionLabel} version`}
                  </span>
                  <ol className="dsm-workbuddy-xdpool-howto-list">
                    <li>{t?.('row.regionHowTo1', { region: regionLabel }) ?? ''}</li>
                    <li>{t?.('row.regionHowTo2') ?? ''}</li>
                    <li>{t?.('row.regionHowTo3') ?? ''}</li>
                    <li>{t?.('row.regionHowTo4') ?? ''}</li>
                  </ol>
                  <p className="dsm-workbuddy-xdpool-note">{t?.('row.regionHowToNote') ?? ''}</p>
                </div>}
          </section>
        : null}

      {accountCount > 0
        ? <div className="dsm-workbuddy-xdpool-grid">
            {/* ---- accounts column ---- */}
            <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-col" aria-label={t?.('row.accountsTitle') ?? 'Accounts'}>
              <div className="dsm-workbuddy-xdpool-col-head">
                <h3 className="dsm-workbuddy-xdpool-col-title">
                  {t?.('row.accountsTitle') ?? 'Accounts'}
                </h3>
                <span className="dsm-workbuddy-xdpool-col-count">{accountSummary}</span>
                <span className="dsm-workbuddy-xdpool-col-actions">
                  {(status?.ignored.length ?? 0) > 0
                    ? <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        title={t?.('row.ignoredSummary', { count: status?.ignored.length ?? 0 }) ?? ''}
                        onClick={() => { setDialog('accounts') }}
                      >
                        {t?.('row.ignoredTitle') ?? 'Removed'} {status?.ignored.length}
                      </button>
                    : null}
                </span>
              </div>
              <div className="dsm-workbuddy-xdpool-col-body">
                {/* Ranked copy: the ROW NUMBER is the pick order, so the list is
                    sorted enabled-first here rather than trusting the host's
                    order (which is credential freshness, not spend order).
                    Disabled accounts keep their number and sink to the bottom. */}
                {rankedAccounts.map(({ account, rank }) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    t={t}
                    isCurrent={status?.activeAccountId === account.id}
                    rank={rank}
                    busy={accountBusyId === account.id}
                    onOpen={() => { setOpenAccountId(account.id) }}
                    onToggle={(disabled) => { void toggleAccountDisabled(account.id, disabled) }}
                  />
                ))}
              </div>
            </section>

            {/* ---- models column ---- */}
            <section className="dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-col" aria-label={t?.('row.modelsTitle') ?? 'Models'}>
              <div className="dsm-workbuddy-xdpool-col-head">
                <h3 className="dsm-workbuddy-xdpool-col-title">
                  {t?.('row.modelsTitle') ?? 'Models'}
                </h3>
                <span className="dsm-workbuddy-xdpool-col-actions">
                  {/* The offline notice sits in the open, not in a tooltip: the
                      failure it reports is "you are looking at a SHORTER list
                      than the gateway offers". */}
                  {status?.catalogSource !== 'fallback'
                    ? null
                    : <span
                        className="dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn"
                        title={status.catalogError ?? undefined}
                      >
                        {t?.('row.catalogOffline') ?? 'offline list'}
                      </span>}
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline"
                    onClick={() => { setDialog('models') }}
                  >
                    {t?.('row.chooseModels') ?? 'Choose models'}
                  </button>
                </span>
              </div>
              <div className="dsm-workbuddy-xdpool-col-body">
                {/* Only the enabled models: the column is a summary of what the
                    pool will actually serve. "Choose models" is where the
                    selection is edited. */}
                {enabledModels.length === 0
                  ? <p className="dsm-workbuddy-xdpool-col-empty">{t?.('row.noModels') ?? 'No models'}</p>
                  : enabledModels.map(model => (
                      <ModelLine
                        key={model.id}
                        model={model}
                        t={t}
                        draft={modelDraft[model.id] ?? { enabled: model.enabled, images: model.supportsImages }}
                      />
                    ))}
              </div>
            </section>
          </div>
        : null}

      {/* ---- usage panel ---- */}
      {status === undefined
        ? null
        : <UsagePanel usage={status.usage} t={t} accountLabel={id => accountLabelOf(status, id)} />}

      {/* ---- dialogs ---- */}
      {openAccount === undefined
        ? null
        : <AccountDialog
            account={openAccount}
            t={t}
            onClose={() => { setOpenAccountId(undefined) }}
            checkinBusy={checkinBusyId === openAccount.id}
            onClaimCheckin={() => { void claimCheckin(openAccount.id) }}
            reserveBusy={reserveBusy === openAccount.id}
            onSaveCreditReserve={(reserve) => saveCreditReserve(openAccount.id, reserve)}
            accountBusy={accountBusyId === openAccount.id}
            onToggleDisabled={(disabled) => { void toggleAccountDisabled(openAccount.id, disabled) }}
            onIgnore={() => { void setAccountIgnored(openAccount.id, true) }}
          />}

      {scheduleOpen && status?.automation !== undefined
        ? <Dialog
            t={t}
            title={t?.('row.schedule') ?? 'Schedule'}
            sub={t?.('row.autoTitle') ?? 'Automation'}
            onClose={() => { setScheduleOpen(false) }}
          >
            <div className="dsm-workbuddy-xdpool-sec">
              {AUTOMATION_JOBS.map(kind => {
                const job = automationJob(status, kind)
                const hours = automationHours(status, kind)
                return (
                  <div key={kind} className="dsm-workbuddy-xdpool-field">
                    <span className="dsm-workbuddy-xdpool-field-label" style={{ minWidth: 84 }}>
                      {t?.(`row.autoJob_${kind}`) ?? kind}
                    </span>
                    <span className="dsm-workbuddy-xdpool-checkin-meta">
                      {hours.length === 0
                        ? (t?.('row.autoHourNone') ?? 'skipped')
                        : hours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(' · ')}
                    </span>
                    <span className="dsm-workbuddy-xdpool-field-hint" style={{ marginLeft: 'auto' }}>
                      {/* The TIME, not just the date. A date-only stamp cannot
                          answer "did this run once today or eight times" —
                          every repeat rendered as the same `2026-09-28 · 2`. */}
                      {job?.lastRunAtMs === undefined
                        ? (t?.('row.autoNever') ?? 'never')
                        : `${formatTime(job.lastRunAtMs)} · ${job.ok}${job.failed > 0 ? `/${job.failed}` : ''}`}
                    </span>
                    {job?.progress === undefined
                      ? null
                      : <span className="dsm-workbuddy-xdpool-field-hint">{job.progress}</span>}
                    {job?.detail === undefined || job.detail.length === 0
                      ? null
                      : <span className="dsm-workbuddy-xdpool-field-hint" style={{ flexBasis: '100%' }}>
                          {job.detail.join(' · ')}
                        </span>}
                  </div>
                )
              })}
            </div>
          </Dialog>
        : null}

      {dialog === 'accounts' && status !== undefined
        ? <Dialog
            t={t}
            title={t?.('row.ignoredTitle') ?? 'Removed accounts'}
            sub={t?.('row.ignoredSummary', { count: status.ignored.length }) ?? ''}
            onClose={closeDialogs}
          >
            {status.ignored.length === 0
              ? <p className="dsm-workbuddy-xdpool-col-empty">{t?.('row.noAccounts') ?? 'None'}</p>
              : <div className="dsm-workbuddy-xdpool-removed">
                  {status.ignored.map(entry => (
                    <div key={entry.id} className="dsm-workbuddy-xdpool-removed-row">
                      <span className="dsm-workbuddy-xdpool-removed-name">{entry.label}</span>
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        title={t?.('row.ignoredRestoreHint') ?? 'Put this account back into the pool'}
                        disabled={accountBusyId === entry.id}
                        onClick={() => { void setAccountIgnored(entry.id, false) }}
                      >
                        {t?.('row.ignoredRestore') ?? 'Restore'}
                      </button>
                    </div>
                  ))}
                </div>}
          </Dialog>
        : null}

      {dialog === 'models' && status !== undefined
        ? <Dialog
            t={t}
            wide
            title={t?.('row.chooseModels') ?? 'Choose models'}
            sub={t?.('row.modelsHint') ?? ''}
            onClose={closeDialogs}
            footer={<>
              <span className="dsm-workbuddy-xdpool-dialog-foot-note">
                {modelsDirty ? (t?.('row.modelsSave') ?? 'Save') : ''}
              </span>
              <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={catalogBusy}
                onClick={() => { void refreshCatalog() }}
                title={t?.('row.catalogRefreshHint') ?? 'Fetch the model list again from WorkBuddy'}
              >
                {catalogBusy
                  ? (t?.('row.catalogRefreshing') ?? 'Fetching…')
                  : (t?.('row.catalogRefresh') ?? 'Refresh')}
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
            </>}
          >
            <div className="dsm-workbuddy-xdpool-sec">
              {status.models.map(model => (
                <ModelRow
                  key={model.id}
                  model={model}
                  t={t}
                  draft={modelDraft[model.id] ?? { enabled: model.enabled, images: model.supportsImages }}
                  editable={modelsEditable}
                  onToggle={toggleModel}
                  onToggleImage={toggleModelImage}
                  onBudget={setModelBudget}
                />
              ))}
            </div>
          </Dialog>
        : null}
    </section>
  )
}

/**
 * The usage panel: what the pool served over the retained window.
 *
 * Four breakdowns of one window, all computed host-side so the card never has
 * to agree with the host about what a day or a model is:
 *
 *  - the totals, which answer "how much today / this window";
 *  - a per-day bar strip, which is the trend;
 *  - per-model and per-account tables, which answer "what spent it";
 *  - a per-region split, which is the one dimension a reader cannot infer,
 *    because the two gateways' accounts are otherwise just rows in one list.
 *
 * Tokens are shown only for requests that carried a usage frame. A model the
 * gateway reports nothing for still gets its request count — the alternative is
 * a confident "0" for traffic that demonstrably happened.
 *
 * Nothing is drawn when the window holds no requests at all: an empty panel
 * with four zeroed tables is worse than no panel, because it looks like a
 * broken feature rather than an idle pool.
 */
function UsagePanel({
  usage,
  t,
  accountLabel,
}: {
  usage: PoolWebUsageSummary | undefined
  t?: PoolCardProps['t']
  /** Resolve an account id to the name the account list shows. */
  accountLabel: (accountId: string) => string
}) {
  const [tab, setTab] = useState<'models' | 'accounts' | 'regions'>('models')
  if (usage === undefined || usage.totals.requests === 0) return null

  const peak = usage.days.reduce((max, day) => Math.max(max, day.requests), 0)
  const rows = tab === 'models' ? usage.models : tab === 'accounts' ? usage.accounts : usage.regions
  const today = usage.days[usage.days.length - 1]

  return (
    <section className="dsm-workbuddy-xdpool-card" aria-label={t?.('row.usageTitle') ?? 'Usage'}>
      <div className="dsm-workbuddy-xdpool-col-head">
        <h3 className="dsm-workbuddy-xdpool-col-title">{t?.('row.usageTitle') ?? 'Usage'}</h3>
        <span className="dsm-workbuddy-xdpool-col-count">
          {t?.('row.usageWindow', { from: usage.from, to: usage.to }) ?? `${usage.from} → ${usage.to}`}
        </span>
        <span className="dsm-workbuddy-xdpool-col-actions">
          <div className="dsm-workbuddy-xdpool-seg" role="tablist">
            {(['models', 'accounts', 'regions'] as const).map(kind => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={tab === kind}
                className={`dsm-workbuddy-xdpool-seg-btn${tab === kind ? ' dsm-workbuddy-xdpool-seg-btn-active' : ''}`}
                onClick={() => { setTab(kind) }}
              >
                {kind === 'models'
                  ? (t?.('row.usageByModel') ?? 'Models')
                  : kind === 'accounts'
                    ? (t?.('row.usageByAccount') ?? 'Accounts')
                    : (t?.('row.usageByRegion') ?? 'Regions')}
              </button>
            ))}
          </div>
        </span>
      </div>

      <div className="dsm-workbuddy-xdpool-usage-body">
        {/* Totals. Requests always; tokens only when something reported them. */}
        <div className="dsm-workbuddy-xdpool-facts">
          <div className="dsm-workbuddy-xdpool-fact">
            <span className="dsm-workbuddy-xdpool-fact-label">
              {t?.('row.usageRequestsTotal') ?? 'Requests'}
            </span>
            <span className="dsm-workbuddy-xdpool-fact-value">{formatNumber(usage.totals.requests)}</span>
            {today === undefined
              ? null
              : <span className="dsm-workbuddy-xdpool-fact-when">
                  {t?.('row.usageTodayCount', { count: formatNumber(today.requests) })
                    ?? `${formatNumber(today.requests)} today`}
                </span>}
          </div>
          <div className="dsm-workbuddy-xdpool-fact">
            <span className="dsm-workbuddy-xdpool-fact-label">
              {t?.('row.usageTokensTotal') ?? 'Tokens'}
            </span>
            <span className="dsm-workbuddy-xdpool-fact-value">
              {usage.totals.tokensReported ? formatNumber(usage.totals.tokens) : '–'}
            </span>
            {usage.totals.tokensReported
              ? null
              : <span className="dsm-workbuddy-xdpool-fact-when">
                  {t?.('row.usageTokensUnknown') ?? 'not reported'}
                </span>}
          </div>
        </div>

        {/* The trend. One column per day, scaled to the busiest day in the
            window, with the quiet days kept as empty slots so a gap reads as a
            gap instead of silently closing up. */}
        <div className="dsm-workbuddy-xdpool-usage-chart" title={t?.('row.usageChartHint') ?? 'Requests per day'}>
          {usage.days.map(day => (
            <span
              key={day.key}
              className={`dsm-workbuddy-xdpool-usage-bar${day.requests === 0 ? ' dsm-workbuddy-xdpool-usage-bar-empty' : ''}`}
              title={`${day.key} · ${t?.('row.usageRequests', { count: day.requests }) ?? `${day.requests} req`}`
                + (day.tokensReported
                  ? ` · ${t?.('row.usageTokens', { tokens: formatNumber(day.tokens) }) ?? `${formatNumber(day.tokens)} tok`}`
                  : '')}
            >
              <span
                className="dsm-workbuddy-xdpool-usage-bar-fill"
                style={{ height: `${peak === 0 ? 0 : Math.max(6, Math.round((day.requests / peak) * 100))}%` }}
              />
            </span>
          ))}
        </div>

        {/* The breakdown for the selected tab. */}
        <div className="dsm-workbuddy-xdpool-usage-table">
          {rows.length === 0
            ? <p className="dsm-workbuddy-xdpool-col-empty">{t?.('row.usageEmpty') ?? 'Nothing yet'}</p>
            : rows.map(row => (
                <div key={row.key} className="dsm-workbuddy-xdpool-usage-line">
                  <span className="dsm-workbuddy-xdpool-usage-name" title={row.key}>
                    {tab === 'accounts' ? accountLabel(row.key) : regionLabelOf(row.key, t)}
                  </span>
                  <span className="dsm-workbuddy-xdpool-usage-num">
                    {t?.('row.usageRequests', { count: formatNumber(row.requests) })
                      ?? `${formatNumber(row.requests)} req`}
                  </span>
                  <span className="dsm-workbuddy-xdpool-usage-num dsm-workbuddy-xdpool-usage-num-dim">
                    {row.tokensReported
                      ? (t?.('row.usageTokens', { tokens: formatNumber(row.tokens) }) ?? `${formatNumber(row.tokens)} tok`)
                      : '–'}
                  </span>
                </div>
              ))}
        </div>
      </div>
    </section>
  )
}

/**
 * One compact account line: state dot, name, and the balance.
 *
 * The whole row opens the account dialog; the enable switch inside it stops
 * propagation so flipping the switch does not also open the dialog.
 */
function AccountRow({
  account,
  t,
  isCurrent,
  rank,
  busy,
  onOpen,
  onToggle,
}: {
  account: PoolWebAccount
  t?: PoolCardProps['t']
  isCurrent: boolean
  /** Position in the pick order, 1-based. See the list's own note. */
  rank: number
  busy: boolean
  onOpen: () => void
  onToggle: (disabled: boolean) => void
}) {
  const isDisabled = account.disabled === true
  const isCooling = account.cooling === true
  const credits = account.credits?.total
  const firstBatch = oldestExpiringBatch(account.credits)
  const usage = account.usageTotals
  // The row states itself with the dot and the name's colour, so no state word
  // is printed. The sub-line carries only what those two cannot: the deadline of
  // the batch about to lapse.
  const sub = isCooling && account.cooldownUntil !== undefined
    ? `${t?.('row.cooling') ?? 'Cooling'} ${t?.('row.cooldownUntil', { time: formatTime(Date.parse(account.cooldownUntil)) }) ?? ''}`.trim()
    : firstBatch === undefined
      ? undefined
      // The batch that lapses first, on its own line: a total tells the user
      // what they hold, this tells them what they are about to lose.
      : (t?.('row.creditsFirstExpiry', {
          credit: formatNumber(firstBatch.remain),
          days: firstBatch.days,
        }) ?? `${formatNumber(firstBatch.remain)} expire in ${firstBatch.days}d`)
  // Today's spend. A free model moves no credits, so this line is the ONLY
  // evidence it was used at all.
  const usageText = usage === undefined
    ? undefined
    : [
        t?.('row.usageRequests', { count: usage.requests }) ?? `${usage.requests} req`,
        usage.tokensReported
          ? (t?.('row.usageTokens', { tokens: formatNumber(usage.tokens) }) ?? `${formatNumber(usage.tokens)} tok`)
          : null,
      ].filter(part => part !== null).join(' · ')
  // Rank order is the pick order, but only under `priority`, where the head of
  // the list answers every request. The other two distributions rotate, so a
  // number there would claim an order that does not exist.
  // `off` outranks `warn`: a switched-off account's cooldown is moot, and the
  // user's own decision is the more useful thing to read back.
  const state = isDisabled ? 'off' : isCooling ? 'warn' : isCurrent ? 'current' : 'ok'
  return (
    <div
      className={`dsm-workbuddy-xdpool-row dsm-workbuddy-xdpool-row-${state}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }}
    >
      <span className="dsm-workbuddy-xdpool-row-rank">{rank}</span>
      <span className="dsm-workbuddy-xdpool-row-body">
        <span className="dsm-workbuddy-xdpool-row-top">
          <span className="dsm-workbuddy-xdpool-row-dot" data-state={state} />
          <span className="dsm-workbuddy-xdpool-row-name" title={account.label}>
            {splitLabel(account.label).name}
          </span>
          {usageText === undefined
            ? null
            : <span
                className="dsm-workbuddy-xdpool-row-usage"
                title={t?.('row.usageTodayHint') ?? 'Requests and tokens served today'}
              >
                {usageText}
              </span>}
        </span>
        {sub === undefined ? null : <span className="dsm-workbuddy-xdpool-row-sub">{sub}</span>}
      </span>
      <span className="dsm-workbuddy-xdpool-row-value">{formatNumber(credits)}</span>
      <span className="dsm-workbuddy-xdpool-row-tags">
        {account.reserved === true
          ? <span className="dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn">
              {t?.('row.reserveHolding') ?? 'Reserved'}
            </span>
          : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!isDisabled}
        aria-label={isDisabled
          ? (t?.('row.enableAccount') ?? 'Enable')
          : (t?.('row.disableAccount') ?? 'Disable')}
        className={`dsm-workbuddy-xdpool-switch${isDisabled ? '' : ' dsm-workbuddy-xdpool-switch-on'}`}
        title={t?.('row.accountToggleHint') ?? 'Include this account in the pool'}
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); onToggle(!isDisabled) }}
      />
    </div>
  )
}

/**
 * One compact model line for the models column.
 *
 * Read-only beyond the enable checkbox: the row is the summary, and the
 * context-window and image controls live in the "Choose models" dialog.
 *
 * The row deliberately does NOT print the model id. The id is what the gateway
 * keys on, not what the user picks by — the name is unique within a region, and
 * the id only ever appeared here as noise beside it. What the user does need at
 * a glance is the credit multiplier, which is what decides the cost of a
 * request, so that is the line's figure.
 */
function ModelLine({
  model,
  t,
  draft,
}: {
  model: PoolWebModel
  t?: PoolCardProps['t']
  draft: ModelDraftEntry
}) {
  const tag = tagFor(model)
  const tagText = tag === 'free'
    ? (t?.('row.free') ?? 'free')
    : tag === 'limited'
      ? (t?.('row.limitedFree') ?? 'limited')
      : tag === 'night'
        ? (t?.('row.nightDiscount') ?? 'night')
        : null
  /** `x0.00` for free models, `x0.29` otherwise; empty when the gateway is silent. */
  const rate = model.multiplier === undefined
    ? ''
    : `x${model.multiplier.toFixed(2)}`
  // Read-only: the row reports what the pool serves. Changing the selection is
  // the "Choose models" dialog's job, so there is no checkbox competing with the
  // name for the left edge of every line.
  return (
    <div className="dsm-workbuddy-xdpool-mrow-line">
      <span className="dsm-workbuddy-xdpool-row-main">
        <span className="dsm-workbuddy-xdpool-row-name">{model.name}</span>
      </span>
      {/* Rate and capabilities share ONE right-hand line: two short figures do
          not each deserve a line of their own, and stacking them left the right
          half of the column empty. */}
      <span className="dsm-workbuddy-xdpool-row-meta">
        {tagText === null ? null : <span className="dsm-workbuddy-xdpool-chip">{tagText}</span>}
        {draft.images
          ? <span className="dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-dim">
              {t?.('row.modelImage') ?? 'Images'}
            </span>
          : null}
        {rate === ''
          ? null
          : <span
              className="dsm-workbuddy-xdpool-row-rate"
              title={t?.('row.modelRateHint') ?? 'Credits charged per unit, relative to the base rate'}
            >
              {rate}
            </span>}
      </span>
    </div>
  )
}

/** Shared modal shell: scrim, Escape to close, header with a close button. */
function Dialog({
  t,
  title,
  sub,
  wide,
  onClose,
  footer,
  children,
}: {
  t?: PoolCardProps['t']
  title: string
  sub?: string
  wide?: boolean
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  // Escape closes. Bound on the document so it works before focus lands inside
  // the dialog, and removed on unmount so a closed dialog leaves no listener.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div
      className="dsm-workbuddy-xdpool-scrim"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className={`dsm-workbuddy-xdpool-dialog${wide === true ? ' dsm-workbuddy-xdpool-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dsm-workbuddy-xdpool-dialog-head">
          <div className="dsm-workbuddy-xdpool-dialog-titles">
            <h3 className="dsm-workbuddy-xdpool-dialog-title">{title}</h3>
            {sub === undefined || sub === '' ? null : <p className="dsm-workbuddy-xdpool-dialog-sub">{sub}</p>}
          </div>
          <div className="dsm-workbuddy-xdpool-dialog-actions">
            <button
              type="button"
              className="dsm-btn dsm-btn-outline"
              onClick={onClose}
            >
              {t?.('row.close') ?? 'Close'}
            </button>
          </div>
        </div>
        <div className="dsm-workbuddy-xdpool-dialog-body">{children}</div>
        {footer === undefined ? null : <div className="dsm-workbuddy-xdpool-dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * One account's detail dialog: balance and packages, the check-in action, the
 * reserved floor, today's automation take, today's usage, and the destructive
 * "remove" action.
 *
 * Everything here is secondary — the page's account row answers "which account,
 * how much is left, is it on" without it.
 */
function AccountDialog({
  account,
  t,
  onClose,
  checkinBusy,
  onClaimCheckin,
  reserveBusy,
  onSaveCreditReserve,
  accountBusy,
  onToggleDisabled,
  onIgnore,
}: {
  account: PoolWebAccount
  t?: PoolCardProps['t']
  onClose: () => void
  checkinBusy: boolean
  onClaimCheckin: () => void
  reserveBusy: boolean
  onSaveCreditReserve: (reserve: number) => Promise<boolean>
  accountBusy: boolean
  onToggleDisabled: (disabled: boolean) => void
  onIgnore: () => void
}) {
  const isDisabled = account.disabled === true
  const isCooling = account.cooling === true
  const cooldownUntil = account.cooldownUntil !== undefined ? Date.parse(account.cooldownUntil) : undefined
  const modelCooldowns = account.modelCooldowns ?? []
  const credits = account.credits
  const checkin = account.checkin
  const packages = (credits?.packages ?? []).filter(p => (p.size ?? 0) > 0)
  /** The batch that lapses first: the balance says how much, this says how long. */
  const oldestBatch = oldestExpiringBatch(credits)
  const { name, discriminator } = splitLabel(account.label)

  return (
    <Dialog
      t={t}
      title={name}
      {...account.domain === '' || account.domain === undefined ? {} : { sub: account.domain }}
      onClose={onClose}
      footer={<>
        <span className="dsm-workbuddy-xdpool-dialog-foot-note">
          {/* The two account states, both changeable from here. */}
        </span>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline"
          disabled={accountBusy}
          onClick={() => { onToggleDisabled(!isDisabled) }}
        >
          {isDisabled
            ? (t?.('row.enableAccount') ?? 'Enable')
            : (t?.('row.disableAccount') ?? 'Disable')}
        </button>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline dsm-btn-danger"
          title={t?.('row.accountIgnoreHint') ?? 'Remove this account from the pool for good'}
          disabled={accountBusy}
          onClick={onIgnore}
        >
          {t?.('row.accountIgnore') ?? 'Remove'}
        </button>
      </>}
    >
      {/* Facts: balance, check-in streak, reserve. Numbers first, prose never. */}
      <div className="dsm-workbuddy-xdpool-facts">
        <div className="dsm-workbuddy-xdpool-fact">
          <span className="dsm-workbuddy-xdpool-fact-label">{t?.('row.creditsTotal') ?? 'Credits'}</span>
          <span className="dsm-workbuddy-xdpool-fact-value dsm-workbuddy-xdpool-fact-value-ok">
            {account.creditsError !== undefined ? '–' : formatNumber(credits?.total)}
          </span>
        </div>
        {oldestBatch === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-fact">
              <span className="dsm-workbuddy-xdpool-fact-label">
                {t?.('row.creditsFirstBatch') ?? 'Expiring first'}
              </span>
              <span className="dsm-workbuddy-xdpool-fact-value">
                {formatNumber(oldestBatch.remain)}
              </span>
              {/* When, on its own line: the deadline is the half of this fact
                  that the balance above it cannot supply. */}
              <span className="dsm-workbuddy-xdpool-fact-when">
                {oldestBatch.days <= 0
                  ? (t?.('row.creditsExpiresToday') ?? 'today')
                  : (t?.('row.creditsExpiresIn', { days: oldestBatch.days })
                      ?? `in ${oldestBatch.days}d`)}
                {' · '}
                {formatExpiry(oldestBatch.expiresAtMs)}
              </span>
            </div>}
        {credits?.expiringSoon !== undefined && credits.expiringSoon > 0
          ? <div className="dsm-workbuddy-xdpool-fact">
              <span className="dsm-workbuddy-xdpool-fact-label">{t?.('row.creditsSoon') ?? 'Expiring ≤3d'}</span>
              <span className="dsm-workbuddy-xdpool-fact-value">{formatNumber(credits.expiringSoon)}</span>
            </div>
          : null}
        {checkin === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-fact">
              <span className="dsm-workbuddy-xdpool-fact-label">{t?.('row.checkinTitle') ?? 'Check-in'}</span>
              <span className="dsm-workbuddy-xdpool-fact-value">
                {t?.('row.checkinStreak', { days: checkin.streakDays }) ?? `${checkin.streakDays}d`}
              </span>
            </div>}
        {discriminator === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-fact">
              <span className="dsm-workbuddy-xdpool-fact-label">
                {t?.('row.accountId') ?? 'UID'}
              </span>
              <span className="dsm-workbuddy-xdpool-fact-value" style={{ fontSize: 12 }}>
                {discriminator}
              </span>
            </div>}
        {account.expiresAt === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-fact">
              <span className="dsm-workbuddy-xdpool-fact-label">Token</span>
              <span className="dsm-workbuddy-xdpool-fact-value" style={{ fontSize: 12 }}>
                {formatDateTime(account.expiresAt)}
              </span>
            </div>}
      </div>

      {account.creditsError !== undefined
        ? <p className="dsm-workbuddy-xdpool-error">{account.creditsError}</p>
        : null}
      {isCooling && cooldownUntil !== undefined && !Number.isNaN(cooldownUntil)
        ? <p className="dsm-workbuddy-xdpool-note">
            {t?.('row.cooldownUntil', { time: formatTime(cooldownUntil) }) ?? ''}
            {' · '}
            {t?.('row.cooldownHits', { hits: account.rateLimitHits ?? 0 }) ?? ''}
          </p>
        : null}
      {modelCooldowns.length === 0
        ? null
        : <div className="dsm-workbuddy-xdpool-field">
            {modelCooldowns.map(mc => (
              <span key={mc.modelId} className="dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn">
                {t?.('row.modelCooling', { model: mc.modelId, time: formatDateTime(mc.until) })
                  ?? `${mc.modelId} to ${formatDateTime(mc.until)}`}
              </span>
            ))}
          </div>}

      {/* Packages. The list is the only place a per-package deadline appears. */}
      {packages.length === 0
        ? null
        : <div className="dsm-workbuddy-xdpool-sec">
            <span className="dsm-workbuddy-xdpool-sec-title">
              {t?.('row.creditsPackages') ?? 'Packages'}
            </span>
            <ul className="dsm-workbuddy-xdpool-packs">
              {packages.map((pack, index) => {
                const expiry = formatExpiry(pack.expiresAtMs)
                const refresh = formatExpiry(pack.cycleRefreshMs)
                const soon = isExpiringSoon(pack)
                // Monthly packs refresh on a cycle; one-off packs expire.
                const when = pack.monthly === true
                  ? (refresh === '' ? null : (t?.('row.creditsRefreshAt', { time: refresh }) ?? `Refreshes ${refresh}`))
                  : (expiry === '' ? null : (t?.('row.creditsExpiresAt', { time: expiry }) ?? `Expires ${expiry}`))
                return (
                  <li key={`${pack.packageName}-${String(index)}`}>
                    <span className="dsm-workbuddy-xdpool-packs-name">{pack.packageName}</span>
                    <span className="dsm-workbuddy-xdpool-packs-value">
                      {t?.('row.creditsPackage', { remain: formatNumber(pack.remain), size: formatNumber(pack.size) })
                        ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`}
                    </span>
                    {when === null ? null
                      : <span
                          className={`dsm-workbuddy-xdpool-packs-when${soon ? ' dsm-workbuddy-xdpool-packs-when-soon' : ''}`}
                          title={t?.('row.creditsExpiresSoonTitle') ?? 'Expiring within 3 days'}
                        >
                          {when}
                        </span>}
                  </li>
                )
              })}
            </ul>
          </div>}

      {/* Check-in: one line, one button. The streak itself is already a fact
          above, so this line carries only the reward detail — repeating "12-day
          streak" here was one of the duplications the redesign removes. */}
      {account.checkinError !== undefined
        ? <p className="dsm-workbuddy-xdpool-error">{account.checkinError}</p>
        : checkin === undefined
          ? null
          : <div className="dsm-workbuddy-xdpool-field">
              <span className="dsm-workbuddy-xdpool-field-label">
                {t?.('row.checkinTitle') ?? 'Daily check-in'}
              </span>
              <span className="dsm-workbuddy-xdpool-checkin-meta">
                {[
                  checkin.dailyCredit > 0
                    ? (t?.('row.checkinDaily', { credit: formatNumber(checkin.dailyCredit) }) ?? '')
                    : null,
                  checkin.isStreakDay && checkin.streakBonusCredit > 0
                    ? (t?.('row.checkinStreakBonus', {
                        days: formatNumber(checkin.nextStreakDay),
                        credit: formatNumber(checkin.streakBonusCredit),
                      }) ?? '')
                    : null,
                ].filter(part => part !== null && part !== '').join(' · ')}
              </span>
              <button
                type="button"
                className="dsm-btn dsm-btn-outline"
                disabled={!checkin.active || checkin.todayCheckedIn || checkinBusy}
                onClick={onClaimCheckin}
              >
                {!checkin.active
                  ? (t?.('row.checkinInactive') ?? 'Unavailable')
                  : checkin.todayCheckedIn
                    ? (t?.('row.checkinClaimed') ?? 'Checked in')
                    : checkinBusy
                      ? (t?.('row.checkinClaiming') ?? 'Checking in…')
                      : (t?.('row.checkinClaim') ?? 'Check in')}
              </button>
            </div>}

      <CreditReserveRow
        account={account}
        t={t}
        busy={reserveBusy}
        onSave={(accountId, reserve) => onSaveCreditReserve(reserve)}
      />

      {/* Automation take for this account, one line per source, omitted when
          nothing was earned rather than a row of zeroes that reads as failure. */}
      {account.automationToday === undefined
        ? null
        : <div className="dsm-workbuddy-xdpool-sec">
            <span className="dsm-workbuddy-xdpool-sec-title">
              {t?.('row.autoEarned') ?? 'Automation today'}
            </span>
            <span className="dsm-workbuddy-xdpool-checkin-meta">
              {[
                account.automationToday.credit > 0
                  ? (t?.('row.autoFromTasks', {
                      credit: account.automationToday.credit,
                      energy: account.automationToday.energy,
                      count: account.automationToday.claimed,
                    }) ?? `Tasks +${account.automationToday.credit}`)
                  : null,
                account.automationToday.checkinCredit > 0
                  ? (t?.('row.autoFromCheckin', { credit: account.automationToday.checkinCredit })
                      ?? `Check-in +${account.automationToday.checkinCredit}`)
                  : null,
                account.automationToday.bonusCredit > 0
                  ? (t?.('row.autoFromBonus', { credit: account.automationToday.bonusCredit })
                      ?? `Streak +${account.automationToday.bonusCredit}`)
                  : null,
                account.automationToday.travelCredit > 0
                  ? (t?.('row.autoFromTravel', { credit: account.automationToday.travelCredit })
                      ?? `Buddy +${account.automationToday.travelCredit}`)
                  : null,
              ].filter(part => part !== null).join(' · ')}
            </span>
          </div>}

      {/* Per-model usage recorded today: the only trace a free or quota-limited
          model leaves, since it moves no credits. The token figure is printed
          only when the upstream reported one. */}
      {account.usageToday === undefined || account.usageToday.length === 0
        ? null
        : <div className="dsm-workbuddy-xdpool-sec">
            <span className="dsm-workbuddy-xdpool-sec-title">
              {t?.('row.usageToday') ?? 'Usage today'}
            </span>
            <span className="dsm-workbuddy-xdpool-checkin-meta">
              {account.usageToday.map(row => (
                `${row.modelId} ${t?.('row.usageRequests', { count: row.requests }) ?? `${row.requests} req`}`
                + (row.tokensReported
                  ? ` · ${t?.('row.usageTokens', { tokens: formatNumber(row.tokens) }) ?? `${formatNumber(row.tokens)} tok`}`
                  : '')
              )).join('  ·  ')}
            </span>
          </div>}
    </Dialog>
  )
}

/**
 * Reserved-credit control for one account.
 *
 * Saving is an EXPLICIT action, not a blur side effect: the old version
 * committed `onBlur`, which meant a value could be written without the user
 * asking for it — and when the write silently failed, the only trace was a
 * notice line at the top of the card that is easy to miss. That is how "I typed
 * a number, reopened, and it says 0 again" happened with no visible error.
 *
 * Now: the field is a draft, Save is enabled only when the draft differs from
 * what the host last reported, and the outcome is shown inline next to the
 * button. Enter also saves, so keyboard flow is not lost.
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
  // refresh after this dialog saved). Never during an edit: that would
  // overwrite what the user is typing.
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
    <div className="dsm-workbuddy-xdpool-field">
      <span className="dsm-workbuddy-xdpool-field-label">
        {t?.('row.reserveTitle') ?? 'Reserve'}
      </span>
      <input
        type="number"
        min={0}
        step={1}
        value={draft}
        disabled={busy}
        className="dsm-workbuddy-xdpool-input"
        aria-label={t?.('row.reserveTitle') ?? 'Reserve'}
        onChange={(event) => {
          setDraft(event.target.value)
          setNote(undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
        }}
      />
      <span className="dsm-workbuddy-xdpool-field-hint">
        {t?.('row.reserveUnit') ?? 'credits'}
      </span>
      <button
        type="button"
        className="dsm-btn dsm-btn-outline"
        disabled={busy || !dirty}
        onClick={() => { void commit() }}
      >
        {busy
          ? (t?.('row.reserveSaving') ?? 'Saving…')
          : (t?.('row.reserveSave') ?? 'Save')}
      </button>
      {note === 'saved'
        ? <span className="dsm-workbuddy-xdpool-inline-ok">
            {next > 0
              ? (t?.('row.reserveSaved', { credits: next }) ?? `Reserving ${next}`)
              : (t?.('row.reserveCleared') ?? 'Reserve cleared')}
          </span>
        : null}
      {note === 'failed'
        ? <span className="dsm-workbuddy-xdpool-inline-bad">
            {t?.('row.reserveFailed') ?? 'Not saved'}
          </span>
        : null}
      {account.reserved === true
        ? <span className="dsm-workbuddy-xdpool-chip dsm-workbuddy-xdpool-chip-warn">
            {t?.('row.reserveHolding') ?? 'Reserved'}
          </span>
        : null}
    </div>
  )
}

/**
 * One model row inside the model dialog.
 *
 * Read-only when the page has no writable settings scope: the checkbox and the
 * context radios stay disabled rather than pretending an edit took hold. The
 * draft lives in the parent, so this component only ever reports intent.
 */
function ModelRow({
  model,
  t,
  draft,
  editable,
  onToggle,
  onToggleImage,
  onBudget,
}: {
  model: PoolWebModel
  t?: PoolCardProps['t']
  draft: ModelDraftEntry
  editable: boolean
  onToggle: (id: string) => void
  onToggleImage: (id: string) => void
  onBudget: (id: string, budget: number) => void
}) {
  const tag = tagFor(model)
  const tagText = tag === 'free'
    ? (t?.('row.free') ?? 'free')
    : tag === 'limited'
      ? (t?.('row.limitedFree') ?? 'limited free')
      : tag === 'night'
        ? (t?.('row.nightDiscount') ?? 'night')
        : null

  const native = model.nativeContextWindow
  const capped = native > DEFAULT_CONTEXT_BUDGET
  const currentBudget = draft.budget ?? native

  return (
    <div className={`dsm-workbuddy-xdpool-mrow${draft.enabled ? '' : ' dsm-workbuddy-xdpool-mrow-off'}`}>
      <div className="dsm-workbuddy-xdpool-mrow-head">
        <label className="dsm-workbuddy-xdpool-mrow-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!editable}
            onChange={() => { onToggle(model.id) }}
          />
          <span className="dsm-workbuddy-xdpool-mrow-copy">
            <span className="dsm-workbuddy-xdpool-mrow-name">
              {model.name}
              {/* A zero multiplier IS the upstream's way of saying "free", so
                  printing "x0.00" next to a model that costs nothing is worse
                  than printing nothing. The badge already carries the label. */}
              {model.multiplier === undefined || model.multiplier === 0 ? null
                : <span className="dsm-workbuddy-xdpool-mrow-when">
                    {' '}
                    {t?.('row.rate', { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`}
                  </span>}
            </span>
            <span className="dsm-workbuddy-xdpool-mrow-id">{model.id}</span>
          </span>
          {tagText === null ? null : <span className="dsm-workbuddy-xdpool-chip">{tagText}</span>}
        </label>
        <label className="dsm-workbuddy-xdpool-mrow-toggle" title={t?.('row.modelImage') ?? 'Image input'}>
          <input
            type="checkbox"
            checked={draft.images}
            disabled={!editable}
            onChange={() => { onToggleImage(model.id) }}
          />
          <span>{t?.('row.modelImage') ?? 'Images'}</span>
        </label>
      </div>
      <div className="dsm-workbuddy-xdpool-mrow-controls">
        {capped
          ? <fieldset className="dsm-workbuddy-xdpool-mrow-budget" aria-label={t?.('row.modelContextBudget') ?? 'Context'}>
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
        <span className="dsm-workbuddy-xdpool-mrow-when">
          {t?.('row.modelOutput', { size: formatCapacity(model.maxOutputTokens) })
            ?? `out ${formatCapacity(model.maxOutputTokens)}`}
        </span>
        {model.supportedEfforts === undefined || model.supportedEfforts.length === 0 ? null
          : <span className="dsm-workbuddy-xdpool-mrow-when">
              {t?.('row.modelReasoning', { efforts: model.supportedEfforts.join(' / ') })
                ?? model.supportedEfforts.join(' / ')}
            </span>}
      </div>
    </div>
  )
}
