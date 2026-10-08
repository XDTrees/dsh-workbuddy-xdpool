/**
 * "Expiring first" distribution tests.
 *
 * The mode exists because one-off credit packs are use-it-or-lose-it: when they
 * expire the credits are gone, while an account whose packs have no deadline
 * loses nothing by waiting. So the pool should spend the soonest-to-die pack
 * first.
 *
 * Both directions are load-bearing. Spend too lazily and credits are burnt for
 * nothing; spend too eagerly — treating "we have never looked" as "about to
 * expire" — and the pool stops behaving like a pool at all. The cases below pin
 * the deadline ordering, the write-through rule that keeps a spent pack from
 * pinning the pool forever, and the two places the reading is actually wired in
 * (the shim's background refresh and the card refresh), because a mode that
 * sorts on a value nobody ever writes is indistinguishable from `priority`.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { poolWebStatus } from '../src/web-status.ts'

const shims: { close(): Promise<void> }[] = []

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-expiry-'))
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
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A scanned pool over `count` fake accounts, already in `expiry` mode. */
async function expiryPool(count: number): Promise<WorkBuddyAccountPool> {
  const instance = new WorkBuddyAccountPool({
    authDirs: [await fakeAuthDir(count)],
    logger: { warn() {}, info() {}, error() {} },
    distribution: 'expiry',
  })
  await instance.scan()
  return instance
}

/** An upstream billing envelope carrying the given raw package rows. */
function creditsEnvelope(accounts: unknown[]): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: 'ok',
    data: { Response: { Data: { Accounts: accounts } } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** A one-off (non-monthly) pack that dies at `expiredTime`. */
function oneOff(expiredTime: string, remain = 50): Record<string, unknown> {
  return {
    PackageName: 'one-off', CapacityType: 1, CapacitySize: 100, CapacityRemain: remain, ExpiredTime: expiredTime,
  }
}

/** A monthly pack: it refreshes on a cycle, so it can never be "wasted". */
function monthly(cycleEndTime: string): Record<string, unknown> {
  return {
    PackageName: 'monthly', CapacityType: 4, CycleCapacitySize: 1000, CycleCapacityRemain: 800, CycleEndTime: cycleEndTime,
  }
}

const DAY = 24 * 60 * 60 * 1000

describe('reading the deadline off a billing response', () => {
  it('takes the soonest one-off pack as the account deadline', async () => {
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => creditsEnvelope([
        oneOff(new Date(Date.now() + 30 * DAY).toISOString()),
        oneOff(new Date(Date.now() + 3 * DAY).toISOString()),
      ])) as unknown as typeof fetch,
    })
    const credits = await client.fetchCredits({
      accessToken: 't', refreshToken: 'r', expiresAtMs: Date.now() + 3_600_000, domain: '',
    } as never)

    const soon = Date.now() + 3 * DAY
    expect(credits.nearestExpiryMs).toBeDefined()
    // Within a second of the sooner pack, not the later one.
    expect(Math.abs((credits.nearestExpiryMs ?? 0) - soon)).toBeLessThan(1_000)
  })

  it('ignores a monthly pack, whose cycle deadline is not a deadline', async () => {
    // A monthly pack refreshes on its cycle, so an imminent CycleEndTime costs
    // the user nothing. Counting it would make `expiry` mode chase a non-loss.
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => creditsEnvelope([
        monthly(new Date(Date.now() + 1_000).toISOString()),
      ])) as unknown as typeof fetch,
    })
    const credits = await client.fetchCredits({
      accessToken: 't', refreshToken: 'r', expiresAtMs: Date.now() + 3_600_000, domain: '',
    } as never)

    expect(credits.nearestExpiryMs).toBeUndefined()
    expect(credits.packages[0]?.expiresAtMs).toBeUndefined()
    // The refresh instant is still reported, which is what makes it monthly.
    expect(credits.packages[0]?.refreshAtMs).toBeDefined()
  })
})

describe('expiry mode spends the packs that are about to die', () => {
  it('serves from the account whose deadline is soonest', async () => {
    const instance = await expiryPool(3)
    const [first, second, third] = instance.list()
    // Deliberately NOT in deadline order: the middle account dies first, and
    // the last one has nothing to lose.
    instance.noteCredits(first!.id, 100, Date.now() + 20 * DAY)
    instance.noteCredits(second!.id, 100, Date.now() + 1 * DAY)
    instance.noteCredits(third!.id, 100, undefined)

    const picked = await instance.acquire()
    expect(picked?.id).toBe(second!.id)
  })

  it('falls back to priority when nobody has ever been read', async () => {
    // "We have not looked" must not outrank a real deadline — and with no
    // readings at all there is nothing to sort by, so the pool behaves exactly
    // as it does in priority mode.
    const instance = await expiryPool(2)
    const [first] = instance.list()
    const picked = await instance.acquire()
    expect(picked?.id).toBe(first!.id)
  })

  it('sorts an account with no deadline after one that has a deadline', async () => {
    const instance = await expiryPool(2)
    const [first, second] = instance.list()
    // The FIRST account in pool order has no deadline; the second does.
    instance.noteCredits(first!.id, 100, undefined)
    instance.noteCredits(second!.id, 100, Date.now() + 5 * DAY)

    const picked = await instance.acquire()
    expect(picked?.id).toBe(second!.id)
  })

  it('forgets a deadline once the pack is gone, instead of pinning the pool to it', async () => {
    // Write-through, not merge: a pack that has been spent disappears from the
    // next reading. Keeping the stale deadline would send every request back to
    // an account whose credits are already gone — the opposite of the intent.
    const instance = await expiryPool(2)
    const [first, second] = instance.list()
    instance.noteCredits(first!.id, 100, Date.now() + 1 * DAY)
    instance.noteCredits(second!.id, 100, Date.now() + 30 * DAY)
    expect((await instance.acquire())?.id).toBe(first!.id)

    instance.noteCredits(first!.id, 0, undefined)
    expect(instance.creditExpiryOf(first!.id)).toBeUndefined()
    expect((await instance.acquire())?.id).toBe(second!.id)
  })

  it('keeps pool order when two accounts die at the same instant', async () => {
    const instance = await expiryPool(2)
    const [first, second] = instance.list()
    const at = Date.now() + 2 * DAY
    instance.noteCredits(first!.id, 100, at)
    instance.noteCredits(second!.id, 100, at)

    const picked = await instance.acquire()
    expect(picked?.id).toBe(first!.id)
  })

  it('still drops a reserved account from the running, deadlines or not', async () => {
    // The mode picks within the available pool, so a reserve must survive it.
    const instance = await expiryPool(2)
    const [first, second] = instance.list()
    instance.setCreditReserves({ [first!.id]: 100, [second!.id]: 100 })
    instance.noteCredits(first!.id, 10, Date.now() + 1 * DAY)
    instance.noteCredits(second!.id, 5_000, Date.now() + 30 * DAY)

    const picked = await instance.acquire()
    expect(picked?.id).toBe(second!.id)
  })
})

describe('the deadline is actually wired in from a live reading', () => {
  it('learns it from the shim\'s background balance refresh', async () => {
    const dir = await fakeAuthDir(1)
    const instance = new WorkBuddyAccountPool({
      authDirs: [dir],
      logger: { warn() {}, info() {}, error() {} },
      distribution: 'expiry',
    })
    await instance.scan()
    const account = instance.list()[0]!
    const expiry = new Date(Date.now() + 4 * DAY).toISOString()

    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (url: unknown) => {
        if (String(url).includes('get-user-resource')) return creditsEnvelope([oneOff(expiry)])
        return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({ pool: instance, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    await response.text()

    // The refresh is deliberately fire-and-forget, so wait for it rather than
    // assuming it finished with the response.
    const deadline = await waitFor(() => instance.creditExpiryOf(account.id))
    expect(deadline).toBeDefined()
    expect(Math.abs((deadline ?? 0) - Date.parse(expiry))).toBeLessThan(1_000)
  })

  it('learns it from a card refresh too', async () => {
    // The card refresh is the most frequent place a balance is read, so a mode
    // that only listened to the request path would stay blind on an idle pool.
    const dir = await fakeAuthDir(1)
    const instance = new WorkBuddyAccountPool({
      authDirs: [dir],
      logger: { warn() {}, info() {}, error() {} },
      distribution: 'expiry',
    })
    await instance.scan()
    const account = instance.list()[0]!
    const expiry = new Date(Date.now() + 6 * DAY).toISOString()

    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (url: unknown) => {
        if (String(url).includes('get-user-resource')) return creditsEnvelope([oneOff(expiry)])
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch,
    })

    await poolWebStatus({
      pool: instance,
      catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
      client,
    })

    const deadline = instance.creditExpiryOf(account.id)
    expect(deadline).toBeDefined()
    expect(Math.abs((deadline ?? 0) - Date.parse(expiry))).toBeLessThan(1_000)
  })
})

/** Poll `read` until it answers, or fail after a generous bound. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

process.on('exit', () => {
  for (const shim of shims) void shim.close()
})
