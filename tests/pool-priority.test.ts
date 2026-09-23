/**
 * Account-priority, round-robin, and credential-freshness tests.
 *
 * Three behaviours, all about *which* account serves a request:
 *
 * 1. Priority (the default). The pool drains one account's credits before
 *    moving on, and hands traffic straight back to it once its cooldown lifts —
 *    a round-robin split the spend evenly and left the head account half-used.
 * 2. Round-robin, for users who prefer an even spread. Selectable at runtime.
 * 3. Balanced, which draws from every eligible account with a weighting that
 *    favours whichever has been idle longest. Also selectable at runtime.
 * 3. Credential freshness. When one account has several credential files, the
 *    pool must keep the one the upstream actually accepts. The stored
 *    `expiresAt` cannot answer that: the upstream never rewrites it when it
 *    revokes a token, so a long-dead backup can claim to expire *later* than
 *    the live sign-in — and selecting on it made every endpoint return 401.
 *
 * `accounts.ts` has no host (dsh-*) dependencies, so this suite runs standalone.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'

/** Write one credential file into `<dir>/auth`, returning its path. */
async function writeAuth(
  dir: string,
  name: string,
  document: Record<string, unknown>,
): Promise<string> {
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  const path = join(auth, name)
  await writeFile(path, JSON.stringify(document), 'utf8')
  return path
}

/** A credential document for one account, with the fields the pool reads. */
function credentialDocument(options: {
  accessToken: string
  uid: string
  uin: string
  nickname: string
  /** Epoch ms the upstream says it issued the token. */
  lastRefreshTime?: number
  /** Epoch ms the document claims the token expires at. */
  expiresAt?: number
}): Record<string, unknown> {
  return {
    auth: {
      accessToken: options.accessToken,
      refreshToken: `refresh-${options.accessToken}`,
      // Well inside its refresh window, so the pool never tries to refresh it.
      expiresAt: options.expiresAt ?? Date.now() + 30 * 24 * 3_600_000,
      refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
      ...options.lastRefreshTime === undefined ? {} : { lastRefreshTime: options.lastRefreshTime },
      domain: '',
    },
    account: { uid: options.uid, uin: options.uin, nickname: options.nickname },
  }
}

/** `<dir>/auth` holding three accounts, stalest issue time last. */
async function threeAccounts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-priority-'))
  for (let i = 0; i < 3; i += 1) {
    const name = i === 0
      ? 'workbuddy-desktop.info'
      : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.${i}.uuid.info`
    await writeAuth(dir, name, credentialDocument({
      accessToken: `token-${i}`,
      uid: `uid-${i}-${'0'.repeat(24)}`,
      uin: `10000000000${i}`,
      nickname: `Account${i}`,
      // Staggered issue times so the order is deterministic.
      lastRefreshTime: Date.now() - i * 3_600_000,
    }))
  }
  return join(dir, 'auth')
}

describe('account priority', () => {
  it('serves every request from the same account until it is penalized', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await threeAccounts()] })
    await pool.scan()

    const first = await pool.acquire()
    expect(first).toBeDefined()
    // Priority drains one account before moving on: repeat acquisitions must not
    // walk the pool (that is round-robin, or balanced).
    for (let i = 0; i < 4; i += 1) {
      expect((await pool.acquire())!.id).toBe(first!.id)
    }
  })

  it('moves to the next account only once the head is cooling', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await threeAccounts()] })
    await pool.scan()
    const [head, second] = pool.list()
    expect(head).toBeDefined()
    expect(second).toBeDefined()

    expect((await pool.acquire())!.id).toBe(head!.id)

    pool.penalize(head!.id, Date.now() + 60_000)
    expect((await pool.acquire())!.id).toBe(second!.id)
    // …and it stays there rather than rotating on.
    expect((await pool.acquire())!.id).toBe(second!.id)
  })

  it('hands traffic back to the head account once its cooldown lifts', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await threeAccounts()] })
    await pool.scan()
    const head = pool.list()[0]!

    pool.penalize(head.id, Date.now() + 60_000)
    expect((await pool.acquire())!.id).not.toBe(head.id)

    // Clearing the cooldown restores the priority order, so the head account
    // resumes serving — its credits were never spent while it was cooling.
    pool.resetCooldowns()
    expect((await pool.acquire())!.id).toBe(head.id)
  })

  it('keeps a per-model cooldown from demoting the account for other models', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await threeAccounts()] })
    await pool.scan()
    const head = pool.list()[0]!
    const second = pool.list()[1]!

    pool.penalize(head.id, Date.now() + 60_000, 'hy4-preview')
    // hy4-preview moves on…
    expect((await pool.acquire('hy4-preview'))!.id).toBe(second.id)
    // …while every other model still lands on the head account.
    expect((await pool.acquire('hy3'))!.id).toBe(head.id)
  })
})

describe('balanced distribution', () => {
  /** A pool configured for the weighted draw. */
  async function balancedPool(): Promise<WorkBuddyAccountPool> {
    const pool = new WorkBuddyAccountPool({
      authDirs: [await threeAccounts()],
      distribution: 'balanced',
    })
    await pool.scan()
    return pool
  }

  it('spreads a quiet pool across accounts instead of draining one', async () => {
    const pool = await balancedPool()
    // Priority would return the head account every time; the weighted draw must
    // visit more than one account across a handful of requests.
    const seen = new Set<string>()
    for (let i = 0; i < 12; i += 1) seen.add((await pool.acquire())!.id)
    expect(seen.size).toBeGreaterThan(1)
  })

  it('always answers from an eligible account', async () => {
    const pool = await balancedPool()
    const all = new Set(pool.list().map(account => account.id))
    for (let i = 0; i < 8; i += 1) {
      const picked = await pool.acquire()
      expect(picked).toBeDefined()
      expect(all.has(picked!.id)).toBe(true)
    }
  })

  it('never picks a cooling account while a healthy one exists', async () => {
    const pool = await balancedPool()
    const [head] = pool.list()
    pool.penalize(head!.id, Date.now() + 60_000)
    for (let i = 0; i < 6; i += 1) {
      expect((await pool.acquire())!.id).not.toBe(head!.id)
    }
  })

  it('brings a cooled account back into the draw once its cooldown lifts', async () => {
    const pool = await balancedPool()
    const head = pool.list()[0]!

    pool.penalize(head.id, Date.now() + 60_000)
    expect((await pool.acquire())!.id).not.toBe(head.id)

    // Eligible again — but the draw is weighted, so assert the set rather than
    // the head: it can win again, it is just not guaranteed to.
    pool.resetCooldowns()
    const seen = new Set<string>()
    for (let i = 0; i < 30; i += 1) seen.add((await pool.acquire())!.id)
    expect(seen.has(head.id)).toBe(true)
  })

  it('still honours an explicit pick over the weighted draw', async () => {
    const pool = await balancedPool()
    const target = pool.list()[2]!
    pool.prefer(target.id)
    for (let i = 0; i < 5; i += 1) {
      expect((await pool.acquire())!.id).toBe(target.id)
    }
  })
})

describe('round-robin distribution', () => {
  it('rotates across accounts when the switch is set to round-robin', async () => {
    const pool = new WorkBuddyAccountPool({
      authDirs: [await threeAccounts()],
      distribution: 'round-robin',
    })
    await pool.scan()
    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) seen.add((await pool.acquire())!.id)
    // Three consecutive requests must land on three different accounts.
    expect(seen.size).toBe(3)
  })

  it('switches modes at runtime through applyConfig', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await threeAccounts()] })
    await pool.scan()
    expect(pool.currentDistribution()).toBe('priority')

    // Priority: the head account answers every request.
    const head = (await pool.acquire())!.id
    expect((await pool.acquire())!.id).toBe(head)

    pool.applyConfig({ distribution: 'round-robin' })
    expect(pool.currentDistribution()).toBe('round-robin')
    const rotated = new Set<string>()
    for (let i = 0; i < 3; i += 1) rotated.add((await pool.acquire())!.id)
    // Round-robin is a strict rotation: three requests, three accounts.
    expect(rotated.size).toBe(3)

    // Back to priority: the head account is authoritative again.
    pool.applyConfig({ distribution: 'priority' })
    expect(pool.currentDistribution()).toBe('priority')
    expect((await pool.acquire())!.id).toBe(head)

    // Balanced swaps in at runtime too, and is no longer a single-account drain.
    pool.applyConfig({ distribution: 'balanced' })
    expect(pool.currentDistribution()).toBe('balanced')
    const spread = new Set<string>()
    for (let i = 0; i < 12; i += 1) spread.add((await pool.acquire())!.id)
    expect(spread.size).toBeGreaterThan(1)
  })
})

describe('credential freshness', () => {
  it('prefers the live sign-in over a backup claiming a later expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-fresh-'))
    const identity = { uid: `uid-${'0'.repeat(24)}`, uin: '10000000000', nickname: 'Same' }

    // The live file: the session the desktop app is actually using.
    await writeAuth(dir, 'workbuddy-desktop.info', credentialDocument({
      accessToken: 'token-live',
      ...identity,
      lastRefreshTime: Date.now() - 3_600_000,
      expiresAt: Date.now() + 24 * 3_600_000,
    }))
    // A long-dead backup whose stored expiry reaches further out. Selecting on
    // expiry alone picks this one and every upstream call returns 401.
    await writeAuth(dir, 'workbuddy-desktop.2026-07-08T00-00-00-000Z.1.uuid.info', credentialDocument({
      accessToken: 'token-stale',
      ...identity,
      lastRefreshTime: Date.now() - 90 * 24 * 3_600_000,
      expiresAt: Date.now() + 300 * 24 * 3_600_000,
    }))

    const pool = new WorkBuddyAccountPool({ authDirs: [join(dir, 'auth')] })
    await pool.scan()
    const [account] = pool.list()
    expect(account).toBeDefined()
    expect(account!.credential.accessToken).toBe('token-live')
  })

  it('picks the most recently issued credential when no file is live', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-fresh2-'))
    const identity = { uid: `uid-${'1'.repeat(24)}`, uin: '10000000001', nickname: 'Same' }

    // Two backups, neither live. The newer issue time wins even though the
    // older one claims a later expiry.
    await writeAuth(dir, 'workbuddy-desktop.2026-09-05T00-00-00-000Z.1.uuid.info', credentialDocument({
      accessToken: 'token-newer',
      ...identity,
      lastRefreshTime: Date.now() - 3_600_000,
      expiresAt: Date.now() + 10 * 24 * 3_600_000,
    }))
    await writeAuth(dir, 'workbuddy-desktop.2026-09-05T00-00-00-000Z.2.uuid.info', credentialDocument({
      accessToken: 'token-older',
      ...identity,
      lastRefreshTime: Date.now() - 80 * 24 * 3_600_000,
      expiresAt: Date.now() + 300 * 24 * 3_600_000,
    }))

    const pool = new WorkBuddyAccountPool({ authDirs: [join(dir, 'auth')] })
    await pool.scan()
    const [account] = pool.list()
    expect(account!.credential.accessToken).toBe('token-newer')
  })

  it('falls back to the stored expiry when the document carries no issue time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-fresh3-'))
    const identity = { uid: `uid-${'2'.repeat(24)}`, uin: '10000000002', nickname: 'Same' }

    // Neither file declares `lastRefreshTime` (older builds / plugin copies), so
    // the expiry comparison is the only signal left — it must still pick one.
    await writeAuth(dir, 'workbuddy-desktop.2026-09-05T00-00-00-000Z.1.uuid.info', credentialDocument({
      accessToken: 'token-short',
      ...identity,
      expiresAt: Date.now() + 3_600_000,
    }))
    await writeAuth(dir, 'workbuddy-desktop.2026-09-05T00-00-00-000Z.2.uuid.info', credentialDocument({
      accessToken: 'token-long',
      ...identity,
      expiresAt: Date.now() + 300 * 24 * 3_600_000,
    }))

    const pool = new WorkBuddyAccountPool({ authDirs: [join(dir, 'auth')] })
    await pool.scan()
    const [account] = pool.list()
    expect(account!.credential.accessToken).toBe('token-long')
  })

  it('parses lastRefreshTime in seconds as well as milliseconds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-fresh4-'))
    const issuedSec = Math.floor((Date.now() - 3_600_000) / 1000)

    await writeAuth(dir, 'workbuddy-desktop.info', {
      auth: {
        accessToken: 'token-sec',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        lastRefreshTime: issuedSec,
        domain: '',
      },
      account: { uid: `uid-${'3'.repeat(24)}`, uin: '10000000003', nickname: 'Seconds' },
    })

    const pool = new WorkBuddyAccountPool({ authDirs: [join(dir, 'auth')] })
    await pool.scan()
    const [account] = pool.list()
    expect(account).toBeDefined()
    // Normalized to ms, so it must land near the value we wrote (not 1970).
    expect(account!.credential.lastRefreshAtMs).toBeGreaterThan(Date.now() - 2 * 3_600_000)
  })
})