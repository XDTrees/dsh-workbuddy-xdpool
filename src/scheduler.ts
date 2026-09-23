/**
 * Points automation: the daily pass that keeps every account earning.
 *
 * Three independent jobs run on their own hour lists:
 *
 * - `report` (default 10:00) sends one chat-activity event per account per day.
 *   This is what lights the growth streak and unlocks the `first_buddy` family,
 *   so it must run BEFORE the task-centre pass — otherwise the task list is
 *   read before its counters can have moved.
 * - `tasks`  (default 11:00) enrols every open task and claims every reward the
 *   account has already earned.
 * - `checkin` (default 09:00) is the plain daily check-in.
 *
 * Scheduling follows the reference panel's model rather than a cron: the loop
 * wakes once a minute, and a job fires when the local hour matches one of its
 * configured hours and it has not yet run today. "Run today" is tracked per job
 * as a `YYYY-MM-DD` string, which self-resets at midnight.
 *
 * Everything is serial and failure-isolated: one account throwing skips that
 * account and continues with the next, and one job throwing never stops the
 * loop. `global`-region accounts are skipped entirely — the international
 * gateway has no growth/task system, so calling it would only produce noise.
 */

import type { WorkBuddyAccount, WorkBuddyAccountPool, WorkBuddyCredential } from './accounts'
import { randomUUID } from 'node:crypto'
import { isAlreadyCheckin, regionOf } from './upstream'
import type { WorkBuddyTask, WorkBuddyUpstreamClient } from './upstream'
import {
  APPEARANCE_THEME_KEY, LIGHTHOUSE_EXPERT_ID, automationChain, appearanceChain, buddyAppChain,
  canvasChain, chatChain, expertActualUseEvent, expertChatEvents, expertSummonEvents,
  libraryReadChain, playbookChain, skillChain, templateChains,
} from './task-events.ts'
import type { MarketExpert, TaskEventChain } from './task-events.ts'

/** Per-account gap between upstream calls, so a pool of accounts is not a burst. */
export const AUTOMATION_ACCOUNT_DELAY_MS = 800
/**
 * Gap between two expert summon chains.
 *
 * The scorer does not count two expert uses that land back to back — it reads
 * them as one session — so a pass that fires five chains in a row lights up
 * fewer than five. The reference panel settled on several seconds of real
 * usage rhythm; measured here: a 300ms gap scored 1 of 2 chains, while this
 * gap scores every one.
 */
export const EXPERT_SUMMON_GAP_MS = 6_000

/** How often the loop wakes to look for a due job. */

/**
 * How long to wait for event scoring to land before re-reading the task list.
 *
 * Scoring is asynchronous on the upstream side, so an immediate re-read still
 * shows the old progress and the claim pass would skip a task that is in fact
 * now claimable. Measured: the chain is reflected by about eight seconds.
 */
export const EVENT_SCORE_WAIT_MS = 9_000

/** The app the buddy chain enters, satisfying both buddy tasks. */
const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe'
const BUDDY_APP_NAME = '企鹅教师助手'

/**
 * The fallback record for the 腾讯轻量云 expert, used when the marketplace
 * listing cannot be read. The id is the one the task is scored against.
 */
const LIGHTHOUSE_EXPERT: MarketExpert = {
  expertId: LIGHTHOUSE_EXPERT_ID,
  expertType: 'agent',
  displayName: '腾讯轻量云专家',
  profession: '腾讯轻量云专家',
  version: '1.0.2',
  categories: [],
}

/**
 * Tasks with a chain in this module.
 *
 * Membership is the filter the pass uses before it tries to build one, so a
 * task with no chain costs no upstream call. It has to be kept in step with
 * `chainsFor`'s switch: a code listed here with no case would be read and then
 * silently skipped.
 */
const EVENT_CHAIN_BUILDERS: Readonly<Record<string, true>> = {
  Buddy_App: true,
  Buddy_App_QQ: true,
  create_canvas: true,
  automation_1: true,
  RichMeow_Chat: true,
  playbook_prompt: true,
  template_5: true,
  Hp_Appearance: true,
  Library_read: true,
  skill_1: true,
  expert_5: true,
  Expert_team_use_3: true,
  Expert_lighthouse: true,
}

export const AUTOMATION_TICK_MS = 60_000

/** Which jobs the automation runs, and when. */
/**
 * The persisted daily earnings ledger.
 *
 * `date` is the local day the counters belong to: a ledger from a previous day
 * is discarded on load rather than carried forward as "today".
 */
export interface AutomationLedger {
  date: string
  accounts: Record<string, AutomationAccountEarnings>
}

export interface AutomationOptions {
  /** Master switch; false stops every job. */
  enabled?: boolean
  /** Hour list for the daily check-in job. */
  checkinHours?: readonly number[]
  /** Hour list for the task-centre job (accept + claim). */
  taskHours?: readonly number[]
  /** Hour list for the activity-report job. */
  reportHours?: readonly number[]
  /** Hour list for the streak-redemption job. */
  streakHours?: readonly number[]
  /** Hour list for the buddy travel job. */
  travelHours?: readonly number[]
  /** Per-account serial delay, in milliseconds. */
  accountDelayMs?: number
  /** Override the gap between expert chains, in milliseconds (tests use 0). */
  expertGapMs?: number
  /** Override the event-scoring wait, in milliseconds (tests use 0). */
  eventScoreWaitMs?: number
  /** Override the clock, for tests. */
  now?: () => Date
  /** Logger; defaults to a no-op so tests stay quiet. */
  logger?: SchedulerLogger
  /**
   * Persist the daily earnings ledger, and restore it on construction.
   *
   * The ledger cannot live only in memory: a host restart mid-day would wipe
   * what the automation already earned, and the card would show nothing for
   * rewards that really were collected.
   */
  loadEarnings?: () => AutomationLedger | undefined
  saveEarnings?: (ledger: AutomationLedger) => void
}

/** Logger surface, kept structural so any host logger fits. */
export interface SchedulerLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

/** One job's last-run record, surfaced on the status document. */
export interface AutomationJobState {
  /** `YYYY-MM-DD` of the last completed run, or undefined if it never ran. */
  lastRunDate?: string
  /**
   * The scheduled SLOT of the last run, as `YYYY-MM-DDTHH`.
   *
   * The tick de-duplicates on this rather than on the date: keying on the date
   * alone caps every job at one run a day, which is wrong for a job with two
   * time points — blocking the cat loop's second pass would leave the cat out
   * until tomorrow. Per slot a job runs once in each configured hour, while a
   * repeat tick inside the same hour is still refused.
   */
  lastRunSlot?: string
  /** Epoch ms of the last completed run. */
  lastRunAtMs?: number
  /** Accounts that completed without throwing. */
  ok: number
  /** Accounts that threw (each one skipped, the run continued). */
  failed: number
  /** Credits claimed by the task job on the last run. */
  credit: number
  /** Energy claimed by the task job on the last run. */
  energy: number
  /** Tasks claimed by the task job on the last run. */
  claimed: number
  /** Human-readable summary of the last run. */
  /**
   * What this run actually did, in the words of the task board.
   *
   * `message` is a count ("3 accounts, 5 tasks claimed"); this is the list a
   * person can check off — the reward titles the pass collected. A row showing
   * only a bare number cannot answer "did it do the thing I care about", which
   * is the question the panel exists to answer.
   */
  detail?: readonly string[]
  /**
   * A pending milestone worth naming, when there is one.
   *
   * Streak tiers are why this exists: every tier reads `locked` until enough
   * consecutive days accumulate, and "locked" on its own reads as "broken"
   * rather than "come back in four days".
   */
  progress?: string
  message?: string
}


/**
 * What the automation earned for ONE account today.
 *
 * Reset at the local day boundary alongside the per-job "already ran today"
 * guard, so the card shows today rather than a running total that never
 * answers "did it do anything for this account recently".
 */
export interface AutomationAccountEarnings {
  /** Credits the automation claimed from the task centre today. */
  credit: number
  /** Energy claimed from the task centre today. */
  energy: number
  /** Tasks claimed today. */
  claimed: number
  /**
   * Credits the automation collected from check-in today.
   *
   * Kept separate from `credit` because they are different achievements and the
   * card shows them on their own lines: "the automation claimed 3 tasks" and
   * "the automation checked in" are not the same claim to the user.
   */
  checkinCredit: number
  /** Credits from streak redemption + lottery today. */
  bonusCredit: number
  /** Credits from the buddy adoption / travel loop today. */
  travelCredit: number
  /** Local date the counters belong to. */
  date: string
}
/** What ONE account gained during a single run. */
export interface AutomationAccountGain {
  credit: number
  energy: number
  claimed: number
  checkinCredit: number
  bonusCredit: number
  travelCredit: number
}

/** Totals from running the whole ordered pass at once. */
export interface AutomationRunSummary {
  /** How many jobs actually ran (a job with no hour is skipped). */
  jobsRun: number
  /** Accounts that finished without error, summed across jobs. */
  okCount: number
  /** Accounts that failed, summed across jobs. */
  failed: number
  credit: number
  energy: number
  claimed: number
  /**
   * What each account gained during THIS run, keyed by account id. Only
   * accounts that gained something appear.
   */
  accounts: Readonly<Record<string, AutomationAccountGain>>
}

/** Automation snapshot for the status document and the card. */
export interface AutomationStatus {
  enabled: boolean
  /** Whether the loop is running. */
  running: boolean
  checkinHours: readonly number[]
  taskHours: readonly number[]
  reportHours: readonly number[]
  streakHours: readonly number[]
  travelHours: readonly number[]
  jobs: {
    checkin: AutomationJobState
    report: AutomationJobState
    tasks: AutomationJobState
    streak: AutomationJobState
    travel: AutomationJobState
  }
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number
  /**
   * Per-account totals for today, keyed by account id. Only accounts that
   * actually earned something appear, so the card can render "no earnings"
   * as an absence rather than a zero it has to explain.
   */
  earningsToday: Readonly<Record<string, AutomationAccountEarnings>>
  /**
   * Whether a manual run is in flight right now.
   *
   * A run takes tens of seconds (one upstream call per account per job, plus
   * the scoring wait), which is far too long for the card to hold a request
   * open. The button starts a run and the panel polls this flag instead.
   */
  runInProgress: boolean
}

/** The three plus one job kinds, in a stable order. */
export type AutomationJobKind = 'checkin' | 'tasks' | 'report' | 'streak' | 'travel'

/** The four jobs in the order a tick runs them: report before tasks, always. */
export const AUTOMATION_JOB_KINDS: readonly AutomationJobKind[] = ['checkin', 'report', 'tasks', 'streak', 'travel']

/** Reject anything that is not a job kind, so a route cannot name an unknown job. */
export function isAutomationJobKind(value: unknown): value is AutomationJobKind {
  return typeof value === 'string' && (AUTOMATION_JOB_KINDS as readonly string[]).includes(value)
}

type JobKind = AutomationJobKind

const JOB_KINDS: readonly JobKind[] = AUTOMATION_JOB_KINDS

const EMPTY_JOB_STATE: AutomationJobState = { ok: 0, failed: 0, credit: 0, energy: 0, claimed: 0 }

/** `YYYY-MM-DD` in local time, the day key every job resets on. */
/**
 * What the ledger gained between two snapshots, per account and in total.
 *
 * A diff rather than an absolute read: the card asks "what did this run do",
 * and the ledger holds the whole day, so reporting totals would re-count
 * everything an earlier run had already claimed.
 */
function diffEarnings(
  before: Record<string, AutomationAccountEarnings>,
  after: Record<string, AutomationAccountEarnings>,
): { credit: number; energy: number; claimed: number; accounts: Record<string, AutomationAccountGain> } {
  const accounts: Record<string, AutomationAccountGain> = {}
  let credit = 0
  let energy = 0
  let claimed = 0
  for (const [id, entry] of Object.entries(after)) {
    const was = before[id]
    const gain: AutomationAccountGain = {
      credit: entry.credit - (was?.credit ?? 0),
      energy: entry.energy - (was?.energy ?? 0),
      claimed: entry.claimed - (was?.claimed ?? 0),
      checkinCredit: entry.checkinCredit - (was?.checkinCredit ?? 0),
      bonusCredit: entry.bonusCredit - (was?.bonusCredit ?? 0),
      travelCredit: entry.travelCredit - (was?.travelCredit ?? 0),
    }
    const empty = gain.credit === 0 && gain.energy === 0 && gain.claimed === 0
      && gain.checkinCredit === 0 && gain.bonusCredit === 0 && gain.travelCredit === 0
    // An account that gained nothing is left out entirely, so the card can
    // list just the accounts that actually earned this run.
    if (empty) continue
    accounts[id] = gain
    credit += gain.credit
    energy += gain.energy
    claimed += gain.claimed
  }
  return { credit, energy, claimed, accounts }
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The scheduled SLOT `date` falls in, as `YYYY-MM-DDTHH`.
 *
 * The per-job run guard keys on this instead of the date, so a job configured
 * for several hours runs in each of them while a second tick inside the same
 * hour is still refused.
 */
export function slotKey(date: Date): string {
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}`
}

/**
 * Whether `now`'s local hour is one of `hours`.
 *
 * The reference panel computes a `nextFire` instant and sleeps until it; this
 * loop instead wakes every minute and asks "is any job due now". Both fire at
 * the top of a configured hour, but the polling form cannot miss a slot to a
 * suspended process — a laptop that slept through 10:00 still runs the job the
 * moment it wakes, on the same day.
 */
export function isFireHour(now: Date, hours: readonly number[]): boolean {
  return hours.includes(now.getHours())
}

/** Whether this account may be used: not switched off, not cooling. */
function eligible(account: WorkBuddyAccount, now: number): boolean {
  if (account.cooldownUntilMs > now) return false
  // The growth system is CN-only; a global account has no task centre at all.
  if (regionOf(account.credential.domain) === 'global') return false
  return true
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * The points automation.
 *
 * Owns a single timer loop. Construction is inert — nothing runs until
 * {@link start}, and {@link stop} is idempotent so a plugin teardown that fires
 * twice is harmless.
 */
export class WorkBuddyScheduler {
  private readonly pool: WorkBuddyAccountPool

  private readonly client: WorkBuddyUpstreamClient

  private readonly logger: SchedulerLogger

  private readonly now: () => Date

  private readonly delayMs: number

  /**
   * How long to wait for event scoring before re-reading the task list.
   * Tests set 0 so a pass does not spend nine real seconds per account.
   */
  private readonly eventScoreWaitMs: number

  /**
   * Gap between two expert summon chains.
   * Tests set 0 so a pass does not spend six real seconds per expert.
   */
  private readonly expertGapMs: number

  private enabled: boolean

  private checkinHours: readonly number[]

  private taskHours: readonly number[]

  private reportHours: readonly number[]

  private streakHours: readonly number[]
  private travelHours: readonly number[]

  private timer: NodeJS.Timeout | undefined

  private running = false

  /** Guards against a slow run overlapping the next tick. */
  private busy = false
  /** True while a manual run is in flight, so the card can poll it. */
  private runInFlight = false

  /**
   * Set once {@link stop} is called.
   *
   * Deliberately false before `start`: the loop is not running yet, but a
   * manual `tick` must still work. `stop` is what makes a run abandon the
   * accounts it has not reached yet.
   */
  private stopped = false

  private readonly states: Record<JobKind, AutomationJobState> = {
    checkin: { ...EMPTY_JOB_STATE },
    report: { ...EMPTY_JOB_STATE },
    tasks: { ...EMPTY_JOB_STATE },
    streak: { ...EMPTY_JOB_STATE },
    travel: { ...EMPTY_JOB_STATE },
  }

  private claimableSeen = 0
  /**
   * Credits/energy/tasks earned per account TODAY, keyed by account id.
   *
   * Cleared whenever the day key rolls over, so the card always answers
   * "what did the automation get for THIS account today".
   */
  private earnings = new Map<string, AutomationAccountEarnings>()
  /** Day key the counters above belong to. */
  private earningsDate = ''
  /** Host hooks that persist the ledger across restarts. */
  private readonly loadEarnings: (() => AutomationLedger | undefined) | undefined
  private saveEarningsFn: ((ledger: AutomationLedger) => void) | undefined

  constructor(pool: WorkBuddyAccountPool, client: WorkBuddyUpstreamClient, options: AutomationOptions = {}) {
    this.pool = pool
    this.client = client
    this.logger = options.logger ?? {}
    this.now = options.now ?? (() => new Date())
    this.delayMs = options.accountDelayMs ?? AUTOMATION_ACCOUNT_DELAY_MS
    this.eventScoreWaitMs = options.eventScoreWaitMs ?? EVENT_SCORE_WAIT_MS
    this.expertGapMs = options.expertGapMs ?? EXPERT_SUMMON_GAP_MS
    this.loadEarnings = options.loadEarnings
    this.saveEarningsFn = options.saveEarnings
    // Restore today's ledger, discarding one from an earlier day: the counters
    // answer "what did the automation get TODAY", so yesterday's totals must not
    // be presented as today's.
    const restored = options.loadEarnings?.()
    const today = dayKey(this.now())
    if (restored !== undefined && restored.date === today) {
      for (const [id, entry] of Object.entries(restored.accounts)) this.earnings.set(id, entry)
      this.earningsDate = today
    }
    this.enabled = options.enabled ?? false
    this.checkinHours = options.checkinHours ?? [9]
    this.reportHours = options.reportHours ?? [10]
    this.taskHours = options.taskHours ?? [11]
    this.streakHours = options.streakHours ?? [12]
    // Two passes, not one: a trip loop needs a departure AND a collection, and
    // a cat sent out at the single pass of the day would sit there until
    // tomorrow. Morning out, evening back — the reference panel settled on the
    // same pair for the same reason.
    this.travelHours = options.travelHours ?? [9, 21]
  }

  /** Apply a new configuration; safe to call while running. */
  /**
   * Install the persistence hook once the host settings service is available.
   *
   * Separate from the constructor because the scheduler is built with the pool,
   * long before the settings section exists; a ledger written before that point
   * would have nowhere to go.
   */
  setEarningsPersistence(save: (ledger: AutomationLedger) => void): void {
    this.saveEarningsFn = save
  }

  /**
   * Fold a previously persisted ledger back in, when it belongs to today.
   *
   * Used after the settings document becomes readable, which happens after
   * construction; a ledger from an earlier day is ignored so the counters never
   * claim yesterday as today.
   */
  applyEarningsLedger(ledger: AutomationLedger): void {
    const today = dayKey(this.now())
    if (ledger.date !== today) return
    for (const [id, entry] of Object.entries(ledger.accounts)) this.earnings.set(id, entry)
    this.earningsDate = today
  }

  applyConfig(options: AutomationOptions): void {
    if (options.enabled !== undefined) this.enabled = options.enabled
    if (options.checkinHours !== undefined) this.checkinHours = options.checkinHours
    if (options.reportHours !== undefined) this.reportHours = options.reportHours
    if (options.taskHours !== undefined) this.taskHours = options.taskHours
    if (options.streakHours !== undefined) this.streakHours = options.streakHours
    if (options.travelHours !== undefined) this.travelHours = options.travelHours
  }

  /** Hours for one job, used by the loop and the status document. */
  private hoursOf(kind: JobKind): readonly number[] {
    switch (kind) {
      case 'checkin': return this.checkinHours
      case 'report': return this.reportHours
      case 'tasks': return this.taskHours
      case 'streak': return this.streakHours
      case 'travel': return this.travelHours
    }
  }

  /** Start the loop. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.running = true
    // Unref so the plugin never keeps a host process alive on its own.
    this.timer = setInterval(() => { void this.tick() }, AUTOMATION_TICK_MS)
    this.timer.unref?.()
  }

  /** Stop the loop. Idempotent, and safe before `start`. */
  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Snapshot for the status document. */
  /**
   * Run one job immediately, regardless of the clock.
   *
   * Exists so the automation can be verified from the card without waiting for
   * its hour. A manual run is recorded exactly like a scheduled one, so the
   * timer will not repeat it later the same day: every job is idempotent, but a
   * second pass would still be wasted upstream calls.
   *
   * `force` ignores the already-ran-today guard, which is what pressing the
   * button a second time means.
   */
  async runNow(kind: AutomationJobKind, force = false): Promise<AutomationJobState> {
    const today = dayKey(this.now())
    const state = this.states[kind]
    if (!force && state.lastRunSlot === slotKey(this.now())) return { ...state }
    this.busy = true
    try {
      await this.runJob(kind, today)
    } finally {
      this.busy = false
    }
    return { ...this.states[kind] }
  }

  /**
   * Run every job once, in the scheduled order.
   *
   * Order matters and is not configurable: the activity report has to land
   * before the task pass reads task progress, or the pass sees counters the
   * report would have moved. This is what the card's single button calls.
   */
  /**
   * Start a full pass in the background and return immediately.
   *
   * A pass takes tens of seconds - one upstream round trip per account per job,
   * plus the scoring wait - which is far too long to hold the card request open:
   * the browser or the host web server would time out, and the user would see
   * a hung button for a run that is actually working.
   *
   * Returns whether a run started. A second call while one is in flight is
   * ignored rather than queued: pressing the button twice means hurry up, and
   * the run already under way covers it.
   */
  startRunAll(): boolean {
    if (this.runInFlight) return false
    this.runInFlight = true
    void this.runAll()
      .catch((error: unknown) => {
        this.logger.warn?.('dsh-workbuddy-xdpool automation run failed:', error)
      })
      .finally(() => { this.runInFlight = false })
    return true
  }

  async runAll(): Promise<AutomationRunSummary> {
    const today = dayKey(this.now())
    const before = this.earningsSnapshot()
    let okCount = 0
    let failed = 0
    let jobsRun = 0
    for (const kind of JOB_KINDS) {
      // Runs EVERY job, including one whose hour list is empty: the button
      // is an explicit "do everything now", and a job with no schedule is
      // still one the user can want executed on demand.
      jobsRun += 1
      this.busy = true
      try {
        await this.runJob(kind, today)
      } finally {
        this.busy = false
      }
      okCount += this.states[kind].ok
      failed += this.states[kind].failed
    }
    // Diff the ledger against the pre-run snapshot. Summing per-job state
    // would mix one job's counters into another's, and reporting the
    // absolute totals would re-count everything claimed earlier today.
    const after = this.earningsSnapshot()
    const gained = diffEarnings(before, after)
    return {
      jobsRun,
      okCount,
      failed,
      credit: gained.credit,
      energy: gained.energy,
      claimed: gained.claimed,
      accounts: gained.accounts,
    }
  }

  status(): AutomationStatus {
    const jobs = {} as AutomationStatus['jobs']
    for (const kind of JOB_KINDS) jobs[kind] = { ...this.states[kind] }
    return {
      enabled: this.enabled,
      running: this.running,
      checkinHours: this.checkinHours,
      taskHours: this.taskHours,
      reportHours: this.reportHours,
      streakHours: this.streakHours,
      travelHours: this.travelHours,
      jobs,
      claimableSeen: this.claimableSeen,
      earningsToday: this.earningsSnapshot(),
      runInProgress: this.runInFlight, 
    }
  }

  /**
   * One poll: run every due job, serially.
   *
   * Serial by design — the jobs share the same accounts and the upstream
   * rate-limits per account, so overlapping passes would only trip that limit.
   * A job that throws is recorded and the loop continues.
   */
  private async tick(): Promise<void> {
    if (!this.enabled || this.stopped || this.busy) return
    this.busy = true
    try {
      const now = this.now()
      const slot = slotKey(now)
      const today = dayKey(now)
      // Per SLOT, not per day: a job with two configured hours must run in both.
      // Keying on the date is what left the cat out overnight.
      for (const kind of JOB_KINDS) {
        if (this.stopped) return
        if (this.states[kind].lastRunSlot === slot) continue
        if (!isFireHour(now, this.hoursOf(kind))) continue
        await this.runJob(kind, today)
      }
    } catch (error: unknown) {
      // A defect in the loop itself must not kill the timer.
      this.logger.warn?.('dsh-workbuddy-xdpool automation tick failed:', error)
    } finally {
      this.busy = false
    }
  }

  /** Run one job against every eligible account and record the outcome. */
  /**
   * Add one account's take to today's counters, resetting first if the day
   * rolled over. Called from the task pass, which is the only job that earns.
   */
  /**
   * Today's per-account earnings, as a plain object for the status document.
   *
   * Rolls the day first so a status read just after midnight does not report
   * yesterday's totals under today's date.
   */
  private earningsSnapshot(): Record<string, AutomationAccountEarnings> {
    this.rollEarnings(dayKey(this.now()))
    const out: Record<string, AutomationAccountEarnings> = {}
    for (const [id, entry] of this.earnings) out[id] = { ...entry }
    return out
  }

  /**
   * Add one account take to today counters, resetting first if the day rolled
   * over. Every source is tracked separately so the card can show what earned
   * what, rather than one opaque total.
   */
  private recordEarnings(
    accountId: string,
    today: string,
    delta: Partial<Omit<AutomationAccountEarnings, 'date'>>,
  ): void {
    this.rollEarnings(today)
    const credit = delta.credit ?? 0
    const energy = delta.energy ?? 0
    const claimed = delta.claimed ?? 0
    const checkinCredit = delta.checkinCredit ?? 0
    const bonusCredit = delta.bonusCredit ?? 0
    const travelCredit = delta.travelCredit ?? 0
    const empty = credit === 0 && energy === 0 && claimed === 0
      && checkinCredit === 0 && bonusCredit === 0 && travelCredit === 0
    if (empty) return
    const existing = this.earnings.get(accountId)
    this.earnings.set(accountId, {
      credit: (existing?.credit ?? 0) + credit,
      energy: (existing?.energy ?? 0) + energy,
      claimed: (existing?.claimed ?? 0) + claimed,
      checkinCredit: (existing?.checkinCredit ?? 0) + checkinCredit,
      bonusCredit: (existing?.bonusCredit ?? 0) + bonusCredit,
      travelCredit: (existing?.travelCredit ?? 0) + travelCredit,
      date: today,
    })
    // Persisted on every write: a restart mid-day must not wipe what was
    // already earned, or the card would show nothing for real rewards.
    this.persistEarnings()
  }

  /** Clear the per-account counters when the local day changes. */
  private rollEarnings(today: string): void {
    if (this.earningsDate === today) return
    this.earningsDate = today
    this.earnings.clear()
    this.claimableSeen = 0
    this.persistEarnings()
  }

  /**
   * Write the ledger through the host hook, when one was supplied.
   *
   * Best effort on purpose: a failed save must never abort a run that has
   * already collected rewards, and the in-memory ledger keeps serving the card
   * for the rest of the session either way.
   */
  private persistEarnings(): void {
    if (this.saveEarningsFn === undefined) return
    try {
      const accounts: Record<string, AutomationAccountEarnings> = {}
      for (const [id, entry] of this.earnings) accounts[id] = entry
      this.saveEarningsFn({ date: this.earningsDate, accounts })
    } catch (error: unknown) {
      this.logger.warn?.('dsh-workbuddy-xdpool: could not persist automation earnings:', error)
    }
  }


  /**
   * Run one job against every eligible account and record the outcome.
   *
   * The task job runs in TWO passes. The first sends the event chains that light
   * up client-scored tasks; the second collects rewards. They are separate
   * because scoring lands asynchronously — a chain sent and claimed within the
   * same breath finds the task still un-scored — and because sending is fast
   * while claiming wants the whole pool to have been lit up first. Splitting
   * them costs one shared wait instead of one wait per account.
   */
  private async runJob(kind: JobKind, today: string): Promise<void> {
    const accountWord = kind === 'report' ? 'report' : kind
    let ok = 0
    let failed = 0
    let credit = 0
    let energy = 0
    let claimed = 0
    const detail: string[] = []
    let progressNote: string | undefined
    
    const accounts = this.accountsInOrder()

    // Pass 1 (tasks only): light up the client-scored tasks for EVERY account
    // before claiming any of them. Claiming inside this loop would find each
    // chain still unscored, because scoring lands a few seconds later.
    if (kind === 'tasks') await this.sendEventChains(accounts)

    for (let index = 0; index < accounts.length; index++) {
      if (this.stopped) break
      const account = accounts[index]
      if (account === undefined) continue
      try {
        switch (kind) {
          case 'checkin': {
              try {
                const claim = await this.client.claimDailyCheckin(account.credential)
                // Check-in pays credits, so it belongs in the earnings ledger. A
                // repeat check-in pays 0, which records as a no-op.
                this.recordEarnings(account.id, today, { checkinCredit: claim.credit })
                if (claim.credit > 0) {
                if (claim.credit > 0) detail.push(`签到 +${claim.credit}`)
                  this.logger.info?.(`automation checkin ${account.label}: +${claim.credit} credit`)
                }
              } catch (error: unknown) {
                // "Already checked in today" arrives as an error from the upstream
                // but is an idempotent success: the day is already collected.
                // Counting it as a failure would make a healthy account look
                // broken and would inflate the run summary.
                if (!isAlreadyCheckin(error)) throw error
                this.logger.info?.(`automation checkin ${account.label}: already done today`)
              }
              break
            }
          case 'report': {
            const days = await this.reportOne(account)
            this.logger.info?.(`automation report ${account.label}: streak days=${days}`)
            break
          }
          case 'tasks': {
            const result = await this.runTasks(account)
            credit += result.credit
            energy += result.energy
            claimed += result.claimed
            detail.push(...result.titles)
            this.claimableSeen += result.claimableCount
            this.recordEarnings(account.id, today, { credit: result.credit, energy: result.energy, claimed: result.claimed })
            this.logger.info?.(
              `automation tasks ${account.label}: ${result.claimed} claimed (+${result.credit} credit, +${result.energy} energy, ${result.claimableCount} claimable seen)`,
            )
            break
          }
          case 'streak': {
            const progress = await this.redeemStreak(account)
            if (progress !== undefined) progressNote = progress
            break
          }
          case 'travel': {
            await this.runTravel(account)
            break
          }

        }
        ok++
      } catch (error: unknown) {
        // One account failing never stops the pass: a dead token, a 429 or a
        // malformed payload on one account must not cost the other accounts
        // their daily points.
        failed++
        this.logger.warn?.(`automation ${accountWord} ${account.label} failed:`, error)
      }
      // Serial spacing, but never sleep after the final account.
      if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    const state = this.states[kind]
    // Both stamps: the slot is what the tick de-duplicates on, the date is what
    // the card shows and what the ledger resets on.
    state.lastRunSlot = slotKey(this.now())
    state.lastRunDate = today
    state.lastRunAtMs = this.now().getTime()
    state.ok = ok
    state.failed = failed
    state.credit = credit
    state.energy = energy
    state.claimed = claimed
    state.message = this.summarise(kind, ok, failed, claimed, credit, energy)
    state.detail = detail
    state.progress = progressNote
    this.logger.info?.(`automation ${accountWord}: ${state.message}`)
  }

  /** Compose the one-line summary shown on the card. */
  private summarise(
    kind: JobKind,
    ok: number,
    failed: number,
    claimed: number,
    credit: number,
    energy: number,
  ): string {
    if (kind === 'tasks') {
      const suffix = failed > 0 ? `, ${failed} failed` : ''
      return `${ok} accounts, ${claimed} tasks claimed (+${credit} credit, +${energy} energy)${suffix}`
    }
    const suffix = failed > 0 ? `, ${failed} failed` : ''
    return `${ok} accounts ok${suffix}`
  }

  /**
   * Accounts to run against, in pool order.
   *
   * Disabled accounts are excluded here rather than filtered by the caller so a
   * card switch takes effect on the next pass without any event plumbing.
   */
  private accountsInOrder(): WorkBuddyAccount[] {
    const now = Date.now()
    return this.pool.list().filter(account => {
      if (this.pool.isDisabled(account.id)) return false
      return eligible(account, now)
    })
  }

  /**
   * Send one activity report, then verify it landed.
   *
   * The upstream answers 200 even when it drops the event, so the streak is
   * read back as the oracle: `days > 0` means it counted. A failed read-back is
   * logged and treated as a suspicious result, never as a retry — the report is
   * idempotent per day, and hammering it is exactly what the one-a-day quota
   * exists to avoid.
   */
  private async reportOne(account: WorkBuddyAccount): Promise<number> {
    await this.client.reportActivity(account.credential)
    try {
      const days = await this.client.growthStreakDays(account.credential)
      if (days === 0) {
        // Two innocent causes: a brand-new account whose streak is genuinely 0,
        // and the scoring lag - the counter is written asynchronously, so an
        // immediate read-back can still see the previous value (observed live
        // against one live account: 0 right after the report, 1 a minute later).
        // A later pass settles it; retrying here would only burn the quota.
        this.logger.warn?.(`automation report ${account.label}: streak days=0 right after report (new account or scoring lag?)`)
      }
      return days
    } catch (error: unknown) {
      this.logger.warn?.(`automation report ${account.label}: streak read-back failed:`, error)
      return -1
    }
  }
  private async sendEventChains(accounts: readonly WorkBuddyAccount[]): Promise<void> {
    let sentAnything = false
    for (const account of accounts) {
      if (this.stopped) return
      let tasks: readonly WorkBuddyTask[]
      try {
        tasks = await this.client.listTasks(account.credential)
      } catch (error: unknown) {
        // A read failure here is not fatal: the claim pass will read again and
        // record the failure there.
        this.logger.warn?.(`automation events ${account.label}: list failed:`, error)
        continue
      }
      // Every task still short of its target is a candidate. The chains build
      // their own ids, so there is nothing to cache between accounts.
      const pending = tasks.filter(task =>
        task.taskCode in EVENT_CHAIN_BUILDERS && !task.claimable && !task.locked)
      for (const task of pending) {
        if (this.stopped) return
        let chains: readonly TaskEventChain[]
        try {
          chains = await this.chainsFor(task, account.credential)
        } catch (error: unknown) {
          this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} could not be built:`, error)
          continue
        }
        for (const chain of chains) {
          if (this.stopped) return
          try {
            await this.sendChain(account.credential, chain)
            this.logger.info?.(`automation events ${account.label}: ${task.taskCode} chain sent`)
            sentAnything = true
          } catch (error: unknown) {
            // One chain failing must not stop the others or the claim pass.
            this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} failed:`, error)
            break
          }
          if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
        }
      }
    }
    // Scoring lands a few seconds after the events. Waiting it out here is what
    // lets the claim pass that follows collect the reward on THIS run instead of
    // leaving it for a later one. Paid once for the pool.
    if (sentAnything && this.eventScoreWaitMs > 0 && !this.stopped) await sleep(this.eventScoreWaitMs)
  }

  /**
   * Send one chain on the channel it was built for.
   *
   * The transport is not a detail of the sender: the scorer keys different
   * tasks to different fingerprint families, so a web-scored event posted as a
   * desktop event is accepted and then ignored.
   */
  private async sendChain(credential: WorkBuddyCredential, chain: TaskEventChain): Promise<void> {
    if (chain.transport === 'web') {
      const web = chain.web
      if (web === undefined) throw new Error('web chain without a web event')
      await this.client.reportWebEvent(credential, web.eventCode, web.pageUrl, web.elementId, web.elementName)
      return
    }
    await this.client.reportDesktopEvents(credential, chain.events ?? [])
  }

  /**
   * Build every chain that scores one task.
   *
   * Most tasks need a single chain; `template_5` needs five, because the scorer
   * counts distinct `template_used` events rather than a boolean. The two tasks
   * that join a conversation (skill, expert) open a real one first, which is why
   * this is async.
   */
  private async chainsFor(task: WorkBuddyTask, credential: WorkBuddyCredential): Promise<readonly TaskEventChain[]> {
    switch (task.taskCode) {
      case 'Buddy_App':
      case 'Buddy_App_QQ':
        return [buddyAppChain()]
      case 'create_canvas':
        return [canvasChain()]
      case 'automation_1':
        return [automationChain()]
      case 'RichMeow_Chat':
        return [chatChain()]
      case 'playbook_prompt':
        return [playbookChain()]
      case 'template_5':
        return templateChains()
      case 'Hp_Appearance':
        // The event alone is not the whole chain: the client first stores the
        // selected skin, then reports the apply on the way out of settings.
        await this.client.setAppearanceTheme(credential, APPEARANCE_THEME_KEY)
        if (this.delayMs > 0 && !this.stopped) await sleep(2_000)
        return [appearanceChain()]
      case 'Library_read':
        return [libraryReadChain()]
      case 'skill_1': {
        const chat = await this.client.openConversation(credential)
        if (chat === undefined) throw new Error('skill_1: no server conversation')
        return [skillChain(chat.conversationId, chat.requestId)]
      }
      case 'expert_5':
        return this.expertChains(credential, 'agent', task)
      case 'Expert_team_use_3':
        return this.expertChains(credential, 'team', task)
      case 'Expert_lighthouse':
        return this.lighthouseChains(credential)
      default:
        return []
    }
  }

  /**
   * The summon-and-use chains for the expert tasks.
   *
   * Two steps per expert, and both are load-bearing: the summon events alone are
   * impressions, and a use event on its own scores nothing because the scorer
   * looks the conversation up. Only a real chat with `X-Expert-Id` produces an
   * id it will accept.
   */
  private async expertChains(
    credential: WorkBuddyCredential,
    expertType: 'agent' | 'team',
    task: WorkBuddyTask,
  ): Promise<readonly TaskEventChain[]> {
    // Only as many as are still missing, so a replay of the pass does not
    // re-chat experts the account already used.
    const needed = Math.max(0, task.target - task.current)
    if (needed === 0) return []
    const experts = await this.client.marketExpertList(credential, expertType)
    const out: TaskEventChain[] = []
    for (const expert of experts) {
      if (out.length >= needed) break
      if (this.stopped) break
      try {
        await this.client.reportDesktopEvents(credential, expertSummonEvents(expert))
        if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
        const chat = await this.client.openConversation(credential, expert.expertId)
        if (chat === undefined) continue
        out.push({
          transport: 'desktop',
          events: [
            ...expertChatEvents(expert, chat.conversationId, chat.requestId),
            expertActualUseEvent(expert, chat.conversationId, chat.requestId),
          ],
        })
      } catch (error: unknown) {
        this.logger.warn?.(`automation events expert ${expert.expertId}:`, error)
      }
      // Space the chains out: back-to-back uses collapse into one as far as the
      // scorer is concerned, which is what left this task one short.
      if (this.expertGapMs > 0 && !this.stopped) await sleep(this.expertGapMs)
    }
    return out
  }

  /**
   * The 腾讯轻量云 expert chain.
   *
   * Structurally the same as the expert task, with two differences the scorer
   * checks: `agent_task_created` has to name the expert, and the use event has
   * to report `mode: 'LOCAL'` with an empty type and zero cost — that is what
   * the lighthouse criterion looks for.
   */
  private async lighthouseChains(credential: WorkBuddyCredential): Promise<readonly TaskEventChain[]> {
    let expert = LIGHTHOUSE_EXPERT
    // Prefer the marketplace's own record when it lists this expert, so the
    // version and title come from the server rather than this constant.
    try {
      const listed = await this.client.marketExpertList(credential, 'agent')
      const found = listed.find(item => item.expertId === LIGHTHOUSE_EXPERT_ID)
      if (found !== undefined) expert = found
    } catch (error: unknown) {
      this.logger.warn?.('automation events lighthouse list:', error)
    }
    await this.client.reportDesktopEvents(credential, expertSummonEvents(expert))
    if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    const chat = await this.client.openConversation(credential, expert.expertId)
    if (chat === undefined) throw new Error('Expert_lighthouse: no server conversation')
    const use = expertActualUseEvent(expert, chat.conversationId, chat.requestId, 'LOCAL')
    // Align with the real sample: the lighthouse expert reports no type and no
    // cost, and the scorer matches on that shape.
    use['type'] = ''
    use['cost'] = 0
    return [{
      transport: 'desktop',
      events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), use],
    }]
  }


  /**
   * The task-centre pass for one account.
   *
   * Order matters: enrich first (enrol in everything open), then claim. Both
   * halves are idempotent — accepting an already-accepted task succeeds, and a
   * repeat claim answers `already_claimed` — so a pass that dies halfway is
   * safe to replay on the next tick.
   */
  private async runTasks(account: WorkBuddyAccount): Promise<{
    claimed: number
    credit: number
    energy: number
    claimableCount: number
    /** Reward titles collected on this pass, for the card to list. */
    titles: readonly string[]
  }> {
    const credential = account.credential
    const tasks = await this.client.listTasks(credential)

    const open = tasks
      .filter(task => task.acceptStatus === 'not_accepted' && !task.locked)
      .map(task => task.taskCode)
    if (open.length > 0) await this.client.acceptTasks(credential, open)

    // Re-read once more: pass 1 may have lit up tasks in the meantime, and their
    // scoring has had time to land by the time this pass starts.
    const refreshed = await this.client.listTasks(credential)
    const claimable = refreshed.filter(task => task.claimable && !task.locked)

    let credit = 0
    let energy = 0
    let claimed = 0
    const titles: string[] = []
    for (const task of claimable) {
      if (this.stopped) break
      const reward = await this.client.claimTaskReward(credential, task.taskCode)
      credit += reward.credit
      energy += reward.energy
      if (reward.credit > 0 || reward.energy > 0) {
        claimed++
        titles.push(task.title)
        this.logger.info?.(`automation claim ${account.label}: ${task.title} +${reward.credit}c +${reward.energy}e`)
      } else {
        // already_claimed: the reward was collected on an earlier pass.
        this.logger.info?.(`automation claim ${account.label}: ${task.taskCode} already claimed`)
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    return { claimed, credit, energy, claimableCount: claimable.length, titles }
  }

  /**
   * Streak redemption plus the lottery it unlocks.
   *
   * Tiers unlock on consecutive active days (7/14/28). Redeeming one pays
   * credits, energy, a makeup card and — the part nothing else grants — lottery
   * draws, so the draw runs straight after and only for the chances in hand.
   *
   * Everything here is idempotent: a tier already claimed is skipped by its
   * status, and a draw consumes one chance, so a replay cannot double-spend.
   */
  private async redeemStreak(account: WorkBuddyAccount): Promise<string | undefined> {
    const credential = account.credential
    const status = await this.client.growthStreakFull(credential)

    for (const tier of status.tiers) {
      if (this.stopped) return
      // `locked` is not a failure — it is the normal state until enough days
      // accumulate — and `claimed` needs no action.
      if (tier.status === 'locked' || tier.status === 'claimed') continue
      try {
        await this.client.redeemStreakTier(credential, tier.tier)
        this.logger.info?.(`automation streak ${account.label}: redeemed ${tier.tier} (+${tier.credit}c +${tier.energy}e +${tier.chances} draw(s))`)
        this.recordEarnings(account.id, dayKey(this.now()), { bonusCredit: tier.credit })
      } catch (error: unknown) {
        this.logger.warn?.(`automation streak ${account.label}: redeem ${tier.tier} failed:`, error)
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    // Draw whatever the redemptions just granted, plus anything left over.
    const chances = await this.client.lotteryChances(credential)
    for (let draw = 0; draw < chances; draw += 1) {
      if (this.stopped) return
      try {
        const prize = await this.client.lotteryDraw(credential)
        this.logger.info?.(`automation lottery ${account.label}: draw ${draw + 1}/${chances} -> ${JSON.stringify(prize).slice(0, 120)}`)
      } catch (error: unknown) {
        this.logger.warn?.(`automation lottery ${account.label}: draw failed:`, error)
        // Stop drawing on the first failure: the loop is bounded by the count
        // read before it started, and a failing draw would otherwise spin.
        break
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    // Nothing to redeem yet is the normal state, not a fault: hand back the
    // countdown so the card can say "5 more days" instead of showing a row that
    // looks like it silently failed.
    const pendingTier = status.tiers.find(tier => tier.status === 'locked')
    if (pendingTier !== undefined) {
      const remaining = Math.max(0, pendingTier.days - status.days)
      return remaining > 0
        ? `${pendingTier.tier} in ${remaining}d`
        : `${pendingTier.tier} ready`
    }
    return undefined
  }

  /**
   * One trip through the buddy travel loop for an account.
   *
   * A single pass advances the state machine by at most one step: a trip
   * that has arrived is collected, and an idle buddy is sent out. A buddy
   * already travelling is left alone — there is nothing to do until it lands.
   *
   * Measured against the live upstream: the departed trip reports
   * `dailyLimitReached` immediately, so the once-a-day limit needs no local
   * bookkeeping.
   */
  private async runTravel(account: WorkBuddyAccount): Promise<void> {
    const credential = account.credential
    const buddy = await this.client.buddyInfo(credential)
    if (buddy === undefined) {
      // No buddy yet: adoption is gated on that day's activity report, which
      // the report job has already sent by the time this runs. A rejection
      // here means the gate is not met yet, which is normal, not an error.
      try {
        await this.client.buddyAgree(credential)
        await this.client.buddyAdoptFirst(credential)
        this.logger.info?.(`automation travel ${account.label}: adopted first buddy`)
      } catch (error: unknown) {
        this.logger.info?.(`automation travel ${account.label}: adoption not available yet` + ' (' + String(error).slice(0, 80) + ')')
      }
      return
    }

    const travel = await this.client.buddyTravelStatus(credential)
    if (travel.state === 'arrived') {
      if (travel.recordId === 0) {
        // Arrived without a trip id cannot be claimed; nothing to do.
        this.logger.warn?.(`automation travel ${account.label}: arrived but no record id`)
        return
      }
      const reward = await this.client.buddyTravelClaim(credential, travel.recordId)
      this.recordEarnings(account.id, dayKey(this.now()), { travelCredit: reward })
      this.logger.info?.(`automation travel ${account.label}: claimed trip +${reward}c`)
      return
    }

    if (travel.state === 'idle' && !travel.dailyLimitReached) {
      await this.client.buddyTravelDepart(credential)
      this.logger.info?.(`automation travel ${account.label}: departed (arrives later, claimed next pass)`)
      return
    }

    this.logger.info?.(`automation travel ${account.label}: nothing to do (state=${travel.state})`)
  }
}
