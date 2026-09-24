/**
 * Per-account automation earnings.
 *
 * The card shows "what did the automation get for THIS account today", so the
 * two things that can go wrong are worth pinning: counting wrong, and failing
 * to reset at the day boundary (which would silently turn "today" into "ever").
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyScheduler } from '../src/scheduler.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Build an instant from BEIJING wall-clock parts (see the note in
 * scheduler.test.ts): the scheduler keys its day and hour in Asia/Shanghai, so
 * expectations must not be built in the host timezone or they differ between a
 * developer machine and CI.
 */
function beijing(year: number, monthIndex: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hour - 8, minute))
}

/** Write a fake auth directory holding `count` CN accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-earn-'))
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
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.e.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A pool plus a fake upstream that pays out a fixed reward per claim. */
async function harness(count: number): Promise<{
  pool: WorkBuddyAccountPool
  client: WorkBuddyUpstreamClient
}> {
  const authDirs = [await fakeAuthDir(count)]
  const pool = new WorkBuddyAccountPool({ authDirs, logger: { warn() {} } })
  await pool.scan()
  const fake = {
    async listTasks(): Promise<readonly never[]> {
      return []
    },
    async acceptTasks(): Promise<void> {},
    async claimTaskReward(): Promise<{ credit: number; energy: number }> {
      return { credit: 0, energy: 0 }
    },
    async reportActivity(): Promise<void> {},
    async growthStreakDays(): Promise<number> { return 1 },
    async claimDailyCheckin(): Promise<{ credit: number; streakDays: number; isStreakDay: boolean }> {
      return { credit: 0, streakDays: 1, isStreakDay: false }
    },
  }
  return { pool, client: fake as unknown as WorkBuddyUpstreamClient }
}


describe('automation earnings per account', () => {
  it('starts empty', async () => {
    const { pool, client } = await harness(2)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => beijing(2026, 8, 23, 11, 0, 0) })
    expect(scheduler.status().earningsToday).toEqual({})
  })

  it('records per-account credit, energy and task counts', async () => {
    const { pool, client } = await harness(2)
    const when = beijing(2026, 8, 23, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, {
      enabled: true,
      taskHours: [11],
      accountDelayMs: 0,
      now: () => when,
      logger: { info() {}, warn() {} },
    })
    // The fake returns no tasks, so drive the earnings recorder directly through
    // the public path the task pass uses.
    ;(scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(pool.list()[0]!.id, '2026-09-23', { credit: 250, energy: 8, claimed: 2 })

    const first = pool.list()[0]!
    expect(scheduler.status().earningsToday[first.id]).toEqual({
      credit: 250,
      energy: 8,
      claimed: 2,
      checkinCredit: 0,
      bonusCredit: 0,
      travelCredit: 0,
      date: '2026-09-23',
    })
    // The other account earned nothing, so it is absent rather than zeroed.
    expect(scheduler.status().earningsToday[pool.list()[1]!.id]).toBeUndefined()
  })

  it('accumulates across passes in the same day', async () => {
    const { pool, client } = await harness(1)
    const when = beijing(2026, 8, 23, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    const id = pool.list()[0]!.id
    const recorder = scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }
    recorder.recordEarnings(id, '2026-09-23', { credit: 100, energy: 5, claimed: 1 })
    recorder.recordEarnings(id, '2026-09-23', { credit: 50, energy: 1, claimed: 1 })
    expect(scheduler.status().earningsToday[id]).toEqual({
      credit: 150,
      energy: 6,
      claimed: 2,
      checkinCredit: 0,
      bonusCredit: 0,
      travelCredit: 0,
      date: '2026-09-23',
    })
  })

  it('resets when the local day rolls over', async () => {
    const { pool, client } = await harness(1)
    const day1 = beijing(2026, 8, 23, 23, 30, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => day1, logger: {} })
    const id = pool.list()[0]!.id
    const recorder = scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }
    recorder.recordEarnings(id, '2026-09-23', { credit: 100, energy: 5, claimed: 1 })
    expect(scheduler.status().earningsToday[id]?.credit).toBe(100)

    // Same scheduler, next day: the counters must start over rather than
    // reporting yesterday's total under today's date.
    ;(scheduler as unknown as { now: () => Date }).now = () => beijing(2026, 8, 24, 0, 5, 0)
    expect(scheduler.status().earningsToday).toEqual({})

    recorder.recordEarnings(id, '2026-09-24', { credit: 30, energy: 2, claimed: 1 })
    expect(scheduler.status().earningsToday[id]).toEqual({
      credit: 30,
      energy: 2,
      claimed: 1,
      checkinCredit: 0,
      bonusCredit: 0,
      travelCredit: 0,
      date: '2026-09-24',
    })
  })

  it('does not create an entry for a pass that earned nothing', async () => {
    const { pool, client } = await harness(2)
    const when = beijing(2026, 8, 23, 11, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    const id = pool.list()[0]!.id
    ;(scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(id, '2026-09-23', { credit: 0, energy: 0, claimed: 0 })
    expect(scheduler.status().earningsToday).toEqual({})
  })
})

describe('earnings by source', () => {
  it('records check-in credits on their own line', async () => {
    const { pool, client } = await harness(1)
    const when = beijing(2026, 8, 23, 9, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    const id = pool.list()[0]!.id
    ;(scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(id, '2026-09-23', { checkinCredit: 100 })

    // Check-in must not be folded into the task counter: the card shows them on
    // separate lines precisely because they are different achievements.
    expect(scheduler.status().earningsToday[id]).toMatchObject({
      credit: 0,
      checkinCredit: 100,
    })
  })

  it('keeps each source separate when several run the same day', async () => {
    const { pool, client } = await harness(1)
    const when = beijing(2026, 8, 23, 12, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    const id = pool.list()[0]!.id
    const recorder = scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }
    recorder.recordEarnings(id, '2026-09-23', { checkinCredit: 100 })
    recorder.recordEarnings(id, '2026-09-23', { credit: 300, energy: 8, claimed: 2 })
    recorder.recordEarnings(id, '2026-09-23', { bonusCredit: 50 })
    recorder.recordEarnings(id, '2026-09-23', { travelCredit: 20 })

    expect(scheduler.status().earningsToday[id]).toEqual({
      credit: 300,
      energy: 8,
      claimed: 2,
      checkinCredit: 100,
      bonusCredit: 50,
      travelCredit: 20,
      date: '2026-09-23',
    })
  })

  it('treats a repeat check-in paying nothing as a no-op', async () => {
    const { pool, client } = await harness(1)
    const when = beijing(2026, 8, 23, 9, 0, 0)
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    const id = pool.list()[0]!.id
    ;(scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(id, '2026-09-23', { checkinCredit: 0 })
    expect(scheduler.status().earningsToday).toEqual({})
  })
})
describe('earnings ledger persistence', () => {
  it('writes the ledger on every recorded gain', async () => {
    const { pool, client } = await harness(1)
    const saved: { date: string; accounts: Record<string, unknown> }[] = []
    const scheduler = new WorkBuddyScheduler(pool, client, {
      enabled: true,
      now: () => beijing(2026, 8, 23, 11, 0, 0),
      logger: {},
      saveEarnings: (ledger) => saved.push(ledger as never),
    })
    const id = pool.list()[0]!.id
    ;(scheduler as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(id, '2026-09-23', { credit: 100 })
    // Persisted immediately: a restart right after a claim must not lose it.
    expect(saved.at(-1)?.date).toBe('2026-09-23')
    expect(Object.keys(saved.at(-1)?.accounts ?? {})).toEqual([id])
  })

  it('keeps today ledger across a restart', async () => {
    const { pool, client } = await harness(1)
    const id = pool.list()[0]!.id
    const when = beijing(2026, 8, 23, 11, 0, 0)
    const first = new WorkBuddyScheduler(pool, client, { enabled: true, now: () => when, logger: {} })
    ;(first as unknown as {
      recordEarnings(id: string, today: string, d: Record<string, number>): void
    }).recordEarnings(id, '2026-09-23', { credit: 250, energy: 8, claimed: 2 })
    const ledger = { date: '2026-09-23', accounts: first.status().earningsToday }

    // A fresh scheduler standing in for a restarted host.
    const second = new WorkBuddyScheduler(pool, client, {
      enabled: true,
      now: () => when,
      logger: {},
      loadEarnings: () => ledger,
    })
    expect(second.status().earningsToday[id]?.credit).toBe(250)
  })

  it('discards a ledger from an earlier day', async () => {
    const { pool, client } = await harness(1)
    const id = pool.list()[0]!.id
    const scheduler = new WorkBuddyScheduler(pool, client, {
      enabled: true,
      now: () => beijing(2026, 8, 24, 9, 0, 0),
      logger: {},
      loadEarnings: () => ({
        date: '2026-09-23',
        accounts: { [id]: { credit: 999, energy: 0, claimed: 1, checkinCredit: 0, bonusCredit: 0, travelCredit: 0, date: '2026-09-23' } },
      }),
    })
    // Yesterday's total must never be presented as today's.
    expect(scheduler.status().earningsToday).toEqual({})
  })
})