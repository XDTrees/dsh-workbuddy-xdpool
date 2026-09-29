/**
 * Regression tests for the "runs every hour until midnight" defect.
 *
 * The reported symptom: a job configured for one hour (`checkinHours: [9]`) ran
 * at 13:00, 14:00, 15:00 … every hour on the clock, and the cat-travel job did
 * the same, while the activity report (configured `[10]`) behaved correctly.
 *
 * Root cause: ONE field carried TWO meanings. The gate asked "has the
 * CONFIGURED hour been spent", comparing against `${today}T${candidate}`, while
 * the run recorded `slotKey(now)` — the clock hour it happened to finish at.
 * Those agree only by coincidence, so the gate was open almost all day; the
 * per-hour throttle then capped the damage at one run per clock hour, which is
 * exactly the "every hour" pattern in the logs.
 *
 * Why the report's job behaved and the others did not, in one line: it was
 * configured for 10:00 and the catch-up happened to run AT 10:35, so its record
 * matched the candidate the gate looked for. That coincidence is the proof.
 *
 * These tests drive the private `tick()` with a pinned clock, which is how the
 * rest of this suite exercises the schedule.
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyCredential } from '../src/accounts.ts'
import { WorkBuddyScheduler } from '../src/scheduler.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Build an instant from BEIJING wall-clock parts (monthIndex is 0-based). */
function beijing(year: number, monthIndex: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hour - 8, minute))
}

/**
 * A minimal upstream that records which endpoints were hit.
 *
 * Only the methods the scheduler actually calls are stubbed — the travel job
 * walks `buddyInfo` → `buddyTravelStatus` → `buddyTravelDepart`, so a stub that
 * only answers `buddyAppEvents` silently makes the loop a no-op.
 */
function fakeUpstream() {
  const calls: string[] = []
  const client = {
    async reportActivity() { calls.push('report'); return {} },
    async growthStreakDays() { return 1 },
    async claimDailyCheckin() { calls.push('checkin'); return { credit: 100, streakDays: 1, isStreakDay: false } },
    async fetchCheckinStatus() {
      return { active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 0 }
    },
    async listTasks() { calls.push('listTasks'); return [] },
    async growthStreakFull() { calls.push('streakFull'); return { days: 1, monthTotalDays: 1, nextTier: '7d', nextTierRemaining: 6, makeupCards: 0, tiers: [] } },
    async buddyInfo() { calls.push('buddyInfo'); return { instanceId: 1, name: 'TestCat' } },
    async buddyTravelStatus() { calls.push('travelStatus'); return { state: 'idle', recordId: 0, dailyLimitReached: false, rewardCredit: 0 } },
    async buddyTravelDepart() { calls.push('travel'); return undefined },
    async buddyTravelClaim() { calls.push('travelClaim'); return 10 },
    async reportDesktopEvents() { return undefined },
    async reportWebEvent() { return undefined },
    async openConversation() { return undefined },
    async marketExpertList() { return [] },
    async setAppearanceTheme() { return undefined },
  } as unknown as WorkBuddyUpstreamClient
  return { calls, client }
}

async function poolWithAccounts(count: number): Promise<WorkBuddyAccountPool> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-recur-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    await writeFile(join(auth, i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.${i}.info`), JSON.stringify(document), 'utf8')
  }
  const pool = new WorkBuddyAccountPool({ authDirs: [auth], logger: { warn() {} } })
  await pool.scan()
  return pool
}

function build(
  pool: WorkBuddyAccountPool,
  client: WorkBuddyUpstreamClient,
  when: Date,
  hours: { checkin?: number[]; report?: number[]; tasks?: number[]; streak?: number[]; travel?: number[] },
): WorkBuddyScheduler {
  return new WorkBuddyScheduler(pool, client, {
    enabled: true,
    checkinHours: hours.checkin ?? [],
    reportHours: hours.report ?? [],
    taskHours: hours.tasks ?? [],
    streakHours: hours.streak ?? [],
    travelHours: hours.travel ?? [],
    accountDelayMs: 0,
    eventScoreWaitMs: 0,
    expertGapMs: 0,
    now: () => when,
    logger: { info() {}, warn() {} },
  })
}

/** Drive one tick with a pinned clock. */
async function tickAt(scheduler: WorkBuddyScheduler, when: Date): Promise<void> {
  ;(scheduler as unknown as { now: () => Date }).now = () => when
  await (scheduler as unknown as { tick(): Promise<void> }).tick()
}

/** Count how many times a call was made. */
const count = (calls: readonly string[], name: string): number => calls.filter(call => call === name).length

describe('a job does not re-run every hour after a catch-up', () => {
  it('a [9] check-in that catches up at 10:35 stays quiet for the rest of the day', async () => {
    // The reported case, narrowed to one job. The app starts at 10:35, so the
    // 09:00 candidate is overdue and runs — but the record must be the CONSUMED
    // CANDIDATE (T09), not the clock hour it finished in (T10).
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 10, 35), { checkin: [9] })

    await tickAt(scheduler, beijing(2026, 8, 7, 10, 35))
    expect(count(calls, 'checkin')).toBe(1)

    // Every following hour on the same day must be silent. Before the fix each
    // of these fired again, which is the "直到次日零点" symptom in the report.
    for (const hour of [11, 12, 13, 14, 15, 16, 20, 23]) {
      await tickAt(scheduler, beijing(2026, 8, 7, hour, 0))
    }
    expect(count(calls, 'checkin')).toBe(1)
  })

  it('records the consumed configured hour, not the clock hour it ran at', async () => {
    // The field itself is the contract: this is what the gate compares against.
    const pool = await poolWithAccounts(1)
    const { client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 10, 35), { checkin: [9] })
    await tickAt(scheduler, beijing(2026, 8, 7, 10, 35))

    const state = scheduler.status().jobs.checkin
    expect(state.firedSlots).toEqual(['2026-09-07T09'])
    // The throttle uses the CLOCK hour, and it is a separate field on purpose.
    expect(state.lastFiredHour).toBe('2026-09-07T10')
  })

  it('a second tick inside the same hour is refused', async () => {
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 9, 0), { checkin: [9] })
    await tickAt(scheduler, beijing(2026, 8, 7, 9, 0))
    expect(count(calls, 'checkin')).toBe(1)
    await tickAt(scheduler, beijing(2026, 8, 7, 9, 30))
    expect(count(calls, 'checkin')).toBe(1)
  })

  it('the next day runs again', async () => {
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 9, 0), { checkin: [9] })
    await tickAt(scheduler, beijing(2026, 8, 7, 9, 0))
    await tickAt(scheduler, beijing(2026, 8, 8, 9, 0))
    expect(count(calls, 'checkin')).toBe(2)
  })
})

describe('a job with two hours runs in each of them, once', () => {
  it('travel [9,21] fires at 9 and again at 21, and never between or after', async () => {
    // The second pass must not erase the record of the first: one field could
    // only remember one slot, so after 21:00 the 09:00 candidate looked
    // unconsumed again and the loop re-fired every hour.
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 9, 0), { travel: [9, 21] })

    await tickAt(scheduler, beijing(2026, 8, 7, 9, 0))
    expect(count(calls, 'travel')).toBe(1)

    // Nothing between the two scheduled hours.
    for (const hour of [10, 12, 15, 18, 20]) {
      await tickAt(scheduler, beijing(2026, 8, 7, hour, 0))
    }
    expect(count(calls, 'travel')).toBe(1)

    // The evening pass.
    await tickAt(scheduler, beijing(2026, 8, 7, 21, 0))
    expect(count(calls, 'travel')).toBe(2)

    // And then silence — this is the stretch that used to repeat all night.
    for (const hour of [22, 23]) {
      await tickAt(scheduler, beijing(2026, 8, 7, hour, 0))
    }
    expect(count(calls, 'travel')).toBe(2)

    expect(scheduler.status().jobs.travel.firedSlots).toEqual(['2026-09-07T09', '2026-09-07T21'])
  })

  it('a catch-up consumes only the earliest overdue hour', async () => {
    // Starting at 15:00 with [9, 21] configured: 09:00 is overdue and spent,
    // 21:00 is still ahead and must NOT be consumed by the catch-up.
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 15, 0), { travel: [9, 21] })

    await tickAt(scheduler, beijing(2026, 8, 7, 15, 0))
    expect(count(calls, 'travel')).toBe(1)
    expect(scheduler.status().jobs.travel.firedSlots).toEqual(['2026-09-07T09'])

    // The evening pass still owes a run.
    await tickAt(scheduler, beijing(2026, 8, 7, 21, 0))
    expect(count(calls, 'travel')).toBe(2)
  })
})

describe('a run that crosses the hour boundary is recorded correctly', () => {
  it('a job started at 11:58 and finished after 12:00 consumes T11, not T12', async () => {
    // The recorded slot used to be read at the END of the run, so a pass that
    // straddled the hour wrote the wrong candidate even when it HAD fired on
    // schedule. The consumed slot is now passed in, so the finish time cannot
    // corrupt it.
    const pool = await poolWithAccounts(1)
    const calls: string[] = []
    // The clock advances when the job runs, imitating a real 3-minute pass.
    let clock = beijing(2026, 8, 7, 11, 58)
    const client = {
      async listTasks() { calls.push('listTasks'); return [] },
      async reportActivity() { calls.push('report'); clock = beijing(2026, 8, 7, 12, 1); return {} },
      async claimDailyCheckin() { calls.push('checkin'); clock = beijing(2026, 8, 7, 12, 1); return { credit: 1, streakDays: 1, isStreakDay: false } },
      async fetchCheckinStatus() {
        return { active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 1, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 0 }
      },
      async fetchStreak() { return undefined },
      async buddyAppEvents() { return {} },
      async desktopChatEvents() { return {} },
    } as unknown as WorkBuddyUpstreamClient

    const scheduler = new WorkBuddyScheduler(pool, client, {
      enabled: true,
      checkinHours: [11],
      reportHours: [], taskHours: [], streakHours: [], travelHours: [],
      accountDelayMs: 0, eventScoreWaitMs: 0, expertGapMs: 0,
      now: () => clock,
      logger: { info() {}, warn() {} },
    })

    await tickAt(scheduler, beijing(2026, 8, 7, 11, 58))
    expect(count(calls, 'checkin')).toBe(1)
    // The clock moved past midnight-hour while running; the LEDGER must still
    // name the hour that was scheduled.
    expect(scheduler.status().jobs.checkin.firedSlots).toEqual(['2026-09-07T11'])

    // 12:00 and 13:00 must not re-fire it.
    await tickAt(scheduler, beijing(2026, 8, 7, 13, 0))
    expect(count(calls, 'checkin')).toBe(1)
  })
})

describe('a manual run does not spend the day schedule', () => {
  it('pressing run-now at 10:35 does not cancel the 21:00 pass', async () => {
    // The button means "also do it now", not "consider today done". If a manual
    // pass consumed the remaining candidates, one press would silently cancel
    // the evening cat trip.
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 10, 35), { travel: [9, 21] })

    await scheduler.runAll()
    const afterManual = count(calls, 'travel')
    expect(afterManual).toBeGreaterThan(0)

    // Nothing was consumed by the manual pass...
    expect(scheduler.status().jobs.travel.firedSlots ?? []).toEqual([])

    // ...so the scheduled evening pass still runs.
    await tickAt(scheduler, beijing(2026, 8, 7, 21, 0))
    expect(count(calls, 'travel')).toBeGreaterThan(afterManual)
  })

  it('a manual run still throttles a repeat inside the same hour via force=false', async () => {
    const pool = await poolWithAccounts(1)
    const { calls, client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 10, 35), { checkin: [9] })
    await scheduler.runNow('checkin')
    const once = count(calls, 'checkin')
    await scheduler.runNow('checkin')
    expect(count(calls, 'checkin')).toBe(once)
  })
})

describe('the card can show WHEN a job ran', () => {
  it('the status document carries lastRunAtMs, not just the date', async () => {
    // Without a time, eight runs in one day all render as the same
    // `2026-09-28 · 2` — which is why this defect went unnoticed for so long.
    const pool = await poolWithAccounts(1)
    const { client } = fakeUpstream()
    const when = beijing(2026, 8, 7, 10, 35)
    const scheduler = build(pool, client, when, { checkin: [9] })
    await tickAt(scheduler, when)

    const state = scheduler.status().jobs.checkin
    expect(typeof state.lastRunAtMs).toBe('number')
    expect(state.lastRunAtMs).toBe(when.getTime())
  })

  it('a later run updates the timestamp, so two runs are distinguishable', async () => {
    const pool = await poolWithAccounts(1)
    const { client } = fakeUpstream()
    const scheduler = build(pool, client, beijing(2026, 8, 7, 9, 0), { travel: [9, 21] })
    await tickAt(scheduler, beijing(2026, 8, 7, 9, 0))
    const first = scheduler.status().jobs.travel.lastRunAtMs
    await tickAt(scheduler, beijing(2026, 8, 7, 21, 0))
    const second = scheduler.status().jobs.travel.lastRunAtMs
    expect(second).not.toBe(first)
  })
})
