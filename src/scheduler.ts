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
import { regionOf } from './upstream'
import type { WorkBuddyTask, WorkBuddyUpstreamClient } from './upstream'

/** Per-account gap between upstream calls, so a pool of accounts is not a burst. */
export const AUTOMATION_ACCOUNT_DELAY_MS = 800

/** How often the loop wakes to look for a due job. */
export const AUTOMATION_TICK_MS = 60_000

/** Which jobs the automation runs, and when. */
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
  /** Per-account serial delay, in milliseconds. */
  accountDelayMs?: number
  /** Override the clock, for tests. */
  now?: () => Date
  /** Logger; defaults to a no-op so tests stay quiet. */
  logger?: SchedulerLogger
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
  message?: string
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
  jobs: {
    checkin: AutomationJobState
    report: AutomationJobState
    tasks: AutomationJobState
    streak: AutomationJobState
  }
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number
}

/** The three plus one job kinds, in a stable order. */
type JobKind = 'checkin' | 'tasks' | 'report' | 'streak'

const JOB_KINDS: readonly JobKind[] = ['checkin', 'report', 'tasks', 'streak']

const EMPTY_JOB_STATE: AutomationJobState = { ok: 0, failed: 0, credit: 0, energy: 0, claimed: 0 }

/** `YYYY-MM-DD` in local time, the day key every job resets on. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
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

  private enabled: boolean

  private checkinHours: readonly number[]

  private taskHours: readonly number[]

  private reportHours: readonly number[]

  private streakHours: readonly number[]

  private timer: NodeJS.Timeout | undefined

  private running = false

  /** Guards against a slow run overlapping the next tick. */
  private busy = false

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
  }

  private claimableSeen = 0

  constructor(pool: WorkBuddyAccountPool, client: WorkBuddyUpstreamClient, options: AutomationOptions = {}) {
    this.pool = pool
    this.client = client
    this.logger = options.logger ?? {}
    this.now = options.now ?? (() => new Date())
    this.delayMs = options.accountDelayMs ?? AUTOMATION_ACCOUNT_DELAY_MS
    this.enabled = options.enabled ?? false
    this.checkinHours = options.checkinHours ?? [9]
    this.reportHours = options.reportHours ?? [10]
    this.taskHours = options.taskHours ?? [11]
    this.streakHours = options.streakHours ?? [12]
  }

  /** Apply a new configuration; safe to call while running. */
  applyConfig(options: AutomationOptions): void {
    if (options.enabled !== undefined) this.enabled = options.enabled
    if (options.checkinHours !== undefined) this.checkinHours = options.checkinHours
    if (options.reportHours !== undefined) this.reportHours = options.reportHours
    if (options.taskHours !== undefined) this.taskHours = options.taskHours
    if (options.streakHours !== undefined) this.streakHours = options.streakHours
  }

  /** Hours for one job, used by the loop and the status document. */
  private hoursOf(kind: JobKind): readonly number[] {
    switch (kind) {
      case 'checkin': return this.checkinHours
      case 'report': return this.reportHours
      case 'tasks': return this.taskHours
      case 'streak': return this.streakHours
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
      jobs,
      claimableSeen: this.claimableSeen,
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
      const today = dayKey(now)
      for (const kind of JOB_KINDS) {
        if (this.stopped) return
        if (this.states[kind].lastRunDate === today) continue
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
  private async runJob(kind: JobKind, today: string): Promise<void> {
    const accountWord = kind === 'report' ? 'report' : kind
    let ok = 0
    let failed = 0
    let credit = 0
    let energy = 0
    let claimed = 0

    const accounts = this.accountsInOrder()
    for (let index = 0; index < accounts.length; index++) {
      if (this.stopped) break
      const account = accounts[index]
      if (account === undefined) continue
      try {
        switch (kind) {
          case 'checkin': {
            await this.client.claimDailyCheckin(account.credential)
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
            this.claimableSeen += result.claimableCount
            this.logger.info?.(
              `automation tasks ${account.label}: ${result.claimed} claimed (+${result.credit} credit, +${result.energy} energy, ${result.claimableCount} claimable seen)`,
            )
            break
          }
          case 'streak': {
            await this.redeemStreak(account)
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
    state.lastRunDate = today
    state.lastRunAtMs = this.now().getTime()
    state.ok = ok
    state.failed = failed
    state.credit = credit
    state.energy = energy
    state.claimed = claimed
    state.message = this.summarise(kind, ok, failed, claimed, credit, energy)
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
  }> {
    const credential = account.credential
    const tasks = await this.client.listTasks(credential)

    const open = tasks
      .filter(task => task.acceptStatus === 'not_accepted' && !task.locked)
      .map(task => task.taskCode)
    if (open.length > 0) await this.client.acceptTasks(credential, open)

    // Re-list after accepting so progress reflects whatever the enrolment
    // unlocked, rather than claiming against the pre-accept snapshot.
    const refreshed = open.length > 0 ? await this.client.listTasks(credential) : tasks
    const claimable = refreshed.filter(task => task.claimable && !task.locked)

    let credit = 0
    let energy = 0
    let claimed = 0
    for (const task of claimable) {
      if (this.stopped) break
      const reward = await this.client.claimTaskReward(credential, task.taskCode)
      credit += reward.credit
      energy += reward.energy
      if (reward.credit > 0 || reward.energy > 0) {
        claimed++
        this.logger.info?.(`automation claim ${account.label}: ${task.title} +${reward.credit}c +${reward.energy}e`)
      } else {
        // already_claimed: the reward was collected on an earlier pass.
        this.logger.info?.(`automation claim ${account.label}: ${task.taskCode} already claimed`)
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    return { claimed, credit, energy, claimableCount: claimable.length }
  }

  /**
   * Streak redemption and lottery.
   *
   * Left as a deliberate no-op placeholder: the tier/lottery endpoints need
   * their own round of probing against the live upstream before they can be
   * wired safely, and a wrong call here could burn a redemption. The job slot,
   * scheduling and status plumbing already exist, so filling it in is a
   * self-contained change.
   */
  private async redeemStreak(account: WorkBuddyAccount): Promise<void> {
    this.logger.info?.(`automation streak ${account.label}: not implemented yet (skipped)`)
  }
}
