/**
 * Scheduler tests.
 *
 * The automation spends rewards and makes upstream calls on the user's behalf,
 * so the behaviour under test is the guard rails rather than the happy path:
 *
 * - a job fires only in one of its configured hours,
 * - it fires once per day and not again on the next tick,
 * - a `global` account is never called (that gateway has no growth system),
 * - an account the user switched off, or one that is cooling, is skipped,
 * - one account throwing does not stop the pass.
 *
 * The fake upstream records every call, which is how "never called" is asserted.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyCredential } from '../src/accounts.ts'
import { WorkBuddyScheduler, dayKey, isFireHour } from '../src/scheduler.ts'
import type { WorkBuddyTask, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Write a fake auth directory holding `count` CN accounts. */
async function fakeAuthDir(count: number, domain = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-sched-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain,
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.x.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** Parsed-task shape the scheduler's fake hands back. */
function parsed(code: string, overrides: Partial<WorkBuddyTask> = {}): WorkBuddyTask {
  return {
    taskCode: code,
    title: code,
    credit: 10,
    energy: 1,
    hasReward: true,
    target: 1,
    current: 1,
    acceptStatus: 'accepted',
    status: 'complete',
    claimable: true,
    claimed: false,
    locked: false,
    ...overrides,
  }
}

/** Calls the fake recorded, and the tasks it will hand back. */
interface FakeUpstream {
  client: WorkBuddyUpstreamClient
  calls: string[]
  tasks: WorkBuddyTask[]
  streakDays: number
  failOn: Set<string>
  /** Fail the first `listTasks` call only, to isolate one account. */
  failFirstList: boolean
}

/** Build a fake upstream client covering exactly the methods the scheduler uses. */
function fakeUpstream(): FakeUpstream {
  const state: FakeUpstream = {
    calls: [],
    tasks: [parsed('daily_chat')],
    streakDays: 3,
    failOn: new Set(),
    failFirstList: false,
    client: undefined as unknown as WorkBuddyUpstreamClient,
  }
  const guard = (label: string): void => {
    state.calls.push(label)
    if (state.failOn.has(label)) throw new Error(`boom: ${label}`)
  }
  const fake = {
    async listTasks(_credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]> {
      guard('listTasks')
      if (state.failFirstList) {
        state.failFirstList = false
        throw new Error('boom: first account')
      }
      return state.tasks
    },
    async acceptTasks(_credential: WorkBuddyCredential, codes: readonly string[]): Promise<void> {
      guard(`acceptTasks:${codes.join(',')}`)
    },
    async claimTaskReward(_credential: WorkBuddyCredential, code: string): Promise<{ credit: number; energy: number }> {
      guard(`claim:${code}`)
      return { credit: 10, energy: 1 }
    },
    async reportActivity(): Promise<void> {
      guard('report')
    },
    async growthStreakDays(): Promise<number> {
      guard('streak')
      return state.streakDays
    },
    async claimDailyCheckin(): Promise<{ credit: number; streakDays: number; isStreakDay: boolean }> {
      guard('checkin')
      return { credit: 100, streakDays: 1, isStreakDay: false }
    },
  }
  state.client = fake as unknown as WorkBuddyUpstreamClient
  return state
}

/** A pool over a fake auth dir, plus the upstream it is paired with. */
async function harness(
  accounts: number,
  options: { domain?: string; tasks?: WorkBuddyTask[]; failOn?: string[] } = {},
): Promise<{ pool: WorkBuddyAccountPool; upstream: FakeUpstream }> {
  const authDirs = [await fakeAuthDir(accounts, options.domain ?? '')]
  const pool = new WorkBuddyAccountPool({ authDirs, logger: { warn() {} } })
  await pool.scan()
  const upstream = fakeUpstream()
  if (options.tasks !== undefined) upstream.tasks = options.tasks
  for (const label of options.failOn ?? []) upstream.failOn.add(label)
  return { pool, upstream }
}

describe('scheduler hour matching', () => {
  it('fires only inside a configured hour', () => {
    const at10 = new Date(2026, 8, 7, 10, 30, 0)
    expect(isFireHour(at10, [10])).toBe(true)
    expect(isFireHour(at10, [9, 21])).toBe(false)
  })

  it('keys the day in local time', () => {
    expect(dayKey(new Date(2026, 8, 7, 23, 59, 0))).toBe('2026-09-07')
  })
})

describe('scheduler runs', () => {
  /** Drive one tick by pinning the clock and reaching into the private method. */
  async function tickAt(scheduler: WorkBuddyScheduler, when: Date): Promise<void> {
    ;(scheduler as unknown as { now: () => Date }).now = () => when
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
  }

  function build(
    pool: WorkBuddyAccountPool,
    upstream: FakeUpstream,
    when: Date,
    hours: { checkin?: number[]; report?: number[]; tasks?: number[]; streak?: number[] },
  ): WorkBuddyScheduler {
    return new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: hours.checkin ?? [],
      reportHours: hours.report ?? [],
      taskHours: hours.tasks ?? [],
      streakHours: hours.streak ?? [],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
  }

  it('runs the task pass once per day and not twice', async () => {
    const { pool, upstream } = await harness(2)
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })

    await tickAt(scheduler, when)
    const afterFirst = upstream.calls.filter(call => call.startsWith('claim:')).length
    expect(afterFirst).toBe(2)

    await tickAt(scheduler, when)
    const afterSecond = upstream.calls.filter(call => call.startsWith('claim:')).length
    expect(afterSecond).toBe(2)

    const status = scheduler.status()
    expect(status.jobs.tasks.lastRunDate).toBe('2026-09-07')
    expect(status.jobs.tasks.ok).toBe(2)
    expect(status.jobs.tasks.claimed).toBe(2)
    expect(status.jobs.tasks.credit).toBe(20)
  })

  it('does nothing outside its configured hour', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 15, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual([])
    expect(scheduler.status().jobs.tasks.lastRunDate).toBeUndefined()
  })

  it('accepts only not-accepted unlocked tasks, then claims the claimable ones', async () => {
    const { pool, upstream } = await harness(1, {
      tasks: [
        parsed('fresh', { acceptStatus: 'not_accepted', claimable: false, current: 0, target: 1 }),
        parsed('ready'),
        parsed('locked', { locked: true }),
        parsed('done', { claimable: false }),
      ],
    })
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = build(pool, upstream, when, { tasks: [11] })
    await tickAt(scheduler, when)

    expect(upstream.calls).toContain('acceptTasks:fresh')
    // Only `ready` is claimable: `locked` is excluded, `done` needs no claim,
    // and `fresh` was just enrolled so it is not claimable yet.
    expect(upstream.calls).toContain('claim:ready')
    expect(upstream.calls).not.toContain('claim:locked')
    expect(upstream.calls).not.toContain('claim:done')
    expect(upstream.calls).not.toContain('claim:fresh')
  })

  it('runs the report pass and reads the streak back', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 10, 0, 0)
    const scheduler = build(pool, upstream, when, { report: [10] })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual(['report', 'streak'])
    expect(scheduler.status().jobs.report.ok).toBe(1)
  })

  it('runs report before tasks when both are due', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 10, 0, 0)
    // Both jobs share the 10:00 hour, so ordering is observable.
    const scheduler = build(pool, upstream, when, { report: [10], tasks: [10] })
    await tickAt(scheduler, when)
    const reportAt = upstream.calls.indexOf('report')
    const tasksAt = upstream.calls.findIndex(call => call.startsWith('acceptTasks') || call.startsWith('claim:'))
    expect(reportAt).toBeGreaterThanOrEqual(0)
    expect(tasksAt).toBeGreaterThan(reportAt)
  })
})

describe('scheduler account gating', () => {
  async function tickAt(scheduler: WorkBuddyScheduler, when: Date): Promise<void> {
    ;(scheduler as unknown as { now: () => Date }).now = () => when
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
  }

  it('never calls upstream for a global account', async () => {
    const { pool, upstream } = await harness(1, { domain: 'workbuddy.ai' })
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(upstream.calls).toEqual([])
    expect(scheduler.status().jobs.tasks.ok).toBe(0)
  })

  it('skips an account the user switched off', async () => {
    const { pool, upstream } = await harness(2)
    const disabled = pool.list()[0]
    expect(disabled).toBeDefined()
    pool.applyConfig({ disabledAccountIds: [disabled!.id] })

    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(scheduler.status().jobs.tasks.ok).toBe(1)
    expect(upstream.calls.filter(call => call.startsWith('claim:')).length).toBe(1)
  })

  it('skips a cooling account', async () => {
    const { pool, upstream } = await harness(2)
    const cooling = pool.list()[0]
    pool.penalizeExhausted(cooling!.id)

    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    expect(scheduler.status().jobs.tasks.ok).toBe(1)
  })

  it('isolates a failure to one account and still runs the rest', async () => {
    const { pool, upstream } = await harness(2)
    // The first account's task read blows up; the second must still be paid out.
    upstream.failFirstList = true
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await tickAt(scheduler, when)
    const status = scheduler.status().jobs.tasks
    // Both accounts were attempted; the first threw and the second paid out.
    expect(status.ok + status.failed).toBe(2)
    expect(status.failed).toBe(1)
    expect(status.ok).toBe(1)
    expect(status.credit).toBe(10)
  })
})

describe('scheduler stays off unless enabled', () => {
  it('does not call upstream while disabled', async () => {
    const { pool, upstream } = await harness(1)
    const when = new Date(2026, 8, 7, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: false,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    await (scheduler as unknown as { tick(): Promise<void> }).tick()
    expect(upstream.calls).toEqual([])
  })

  it('surfaces its schedule on the status document', async () => {
    const { pool, upstream } = await harness(1)
    const scheduler = new WorkBuddyScheduler(pool, upstream.client, {
      enabled: true,
      checkinHours: [9],
      reportHours: [10],
      taskHours: [11],
      streakHours: [12],
    })
    const status = scheduler.status()
    expect(status.enabled).toBe(true)
    expect(status.checkinHours).toEqual([9])
    expect(status.reportHours).toEqual([10])
    expect(status.taskHours).toEqual([11])
    expect(status.streakHours).toEqual([12])
  })
})
