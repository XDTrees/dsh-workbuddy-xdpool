/**
 * Regression tests for two failures seen together in the wild.
 *
 * 1. "API key invalid" on the international gateway's `hy4-preview-f`.
 *    The real cause was NOT authentication. A 429 cooled that model on every
 *    account; the next request found no account on its FIRST attempt, and the
 *    shim's `exhaustedByRateLimit` flag — which only records what happened
 *    earlier IN THE SAME request — was still false. The shim therefore answered
 *    401 "no credential found; sign in", DSH rendered that as an invalid API
 *    key, and the user was sent to re-authenticate over a temporary rate limit.
 *
 * 2. Context-overrun "recovery" that could not recover.
 *    The budget came from the catalog window alone: `deepseek-v4.1-flash` is
 *    advertised at 1M, so the target computed to 0.8 * 1M - 2048 = 797952 while
 *    the rejected prompt was already 791793 tokens. Compacting to a target
 *    LARGER than the prompt changed nothing, so the retry overran again — and
 *    the log line made it look as though recovery had run.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** A pool holding `count` CN accounts in the given cooldown state. */
function poolWith(count: number, cooldowns: { model?: Record<string, number>; account?: number } = {}): WorkBuddyAccountPool {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-shim-'))
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.c${i}.info`), JSON.stringify({
      auth: {
        accessToken: `token-${i}`, refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000, domain: 'www.workbuddy.cn',
      },
      account: { uid: `uid-${i}`, uin: `uin-${i}`, nickname: `acct${i}` },
    }))
  }
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], logger: { warn() {} } })
  return pool
}

describe('the pool explains WHY it has no account', () => {
  it('says "empty" when nothing at all is signed in for the gateway', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [mkdtempSync(join(tmpdir(), 'wbpool-none-'))], logger: { warn() {} } })
    await pool.scan()
    expect(pool.unavailableReason('hy4-preview-f', 'cn').reason).toBe('empty')
  })

  it('says "cooling" when the MODEL is cooling on every account', async () => {
    // The reported case: a 429 on hy4-preview-f cooled it everywhere.
    const pool = poolWith(2)
    await pool.scan()
    for (const account of pool.list('cn')) {
      // The second parameter is the RESET INSTANT (an absolute timestamp), not
      // a duration — passing a duration cools nothing.
      pool.penalize(account.id, Date.now() + 60 * 60 * 1000, 'hy4-preview-f')
    }
    const why = pool.unavailableReason('hy4-preview-f', 'cn')
    expect(why.reason).toBe('cooling')
    expect(why.cooling).toBe(2)
    expect(why.total).toBe(2)

    // A DIFFERENT model is still fine on those accounts — the cooldown is
    // per-model, which is why the card keeps the other models usable.
    expect(pool.unavailableReason('hy3', 'cn').reason).toBe('none')
  })

  it('treats an already-expired cooldown as available again', async () => {
    const pool = poolWith(1)
    await pool.scan()
    pool.penalize(pool.list('cn')[0]!.id, Date.now() - 1_000, 'hy4-preview-f')
    expect(pool.unavailableReason('hy4-preview-f', 'cn').reason).toBe('none')
  })

  it('says "cooling" for an account-wide cooldown too', async () => {
    const pool = poolWith(1)
    await pool.scan()
    pool.penalizeExhausted(pool.list('cn')[0]!.id)
    expect(pool.unavailableReason(undefined, 'cn').reason).toBe('cooling')
  })

  it('does not count the other gateway\u2019s accounts', async () => {
    // A region-scoped provider must never be told the other region's accounts
    // can serve it: that would turn "nobody signed in here" into a false 429.
    const pool = poolWith(2)
    await pool.scan()
    expect(pool.unavailableReason('hy4-preview-f', 'global').reason).toBe('empty')
    expect(pool.unavailableReason('hy4-preview-f', 'cn').reason).toBe('none')
  })
})

describe('a rate-limited model reports 429, never 401', () => {
  it('answers 429 when the model is cooling on every account', async () => {
    // Before the fix this returned 401 "not_signed_in", which DSH surfaced as
    // "API key invalid" — the user's report.
    const pool = poolWith(2)
    await pool.scan()
    for (const account of pool.list('cn')) pool.penalize(account.id, Date.now() + 600_000, 'hy4-preview-f')

    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => {
        throw new Error('the transport must not be reached: no account is available')
      }) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    await shim.ready

    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'hy4-preview-f',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    const body = await res.json() as { error?: { code?: string; message?: string } }
    console.log(`\n# status=${res.status} code=${body.error?.code} msg=${body.error?.message?.slice(0, 120)}`)

    expect(res.status).toBe(429)
    expect(body.error?.code).toBe('soft_rate')
    // The message must not tell the user to sign in: the credential is fine.
    expect(body.error?.message ?? '').not.toContain('sign in')

    await shim.close()
  }, 60_000)

  it('still answers 401 when genuinely nothing is signed in', async () => {
    // The distinction is the whole point: opposite remedies.
    const pool = new WorkBuddyAccountPool({ authDirs: [mkdtempSync(join(tmpdir(), 'wbpool-bare-'))], logger: { warn() {} } })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => { throw new Error('unreachable') }) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    await shim.ready

    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview-f', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const body = await res.json() as { error?: { code?: string } }
    expect(res.status).toBe(401)
    expect(body.error?.code).toBe('not_signed_in')
    await shim.close()
  }, 60_000)
})

describe('a 429 names the paid row that is NOT limited', () => {
  /**
   * The gateway prices one product line as several rows sharing a display name
   * and rate-limits each row separately. Verified live:
   *   global: deepseek-v4.1-flash x0.00 / deepseek-v4.1-flash-sg x0.03
   *   CN:     hy3 x0.00 / hy3-x x0.05
   * So "wait it out" is not the only option, and the 429 should say so.
   */
  async function coolingShim(roster: { id: string; name: string; multiplier: number }[]) {
    const pool = poolWith(1)
    await pool.scan()
    pool.penalize(pool.list('cn')[0]!.id, Date.now() + 600_000, 'deepseek-v4.1-flash')
    const catalog = new WorkBuddyCatalog()
    catalog.update(roster.map(row => ({
      id: row.id, name: row.name, multiplier: row.multiplier,
      contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true,
    })))
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => { throw new Error('no account is available') }) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({ pool, client, catalog, region: 'cn' })
    await shim.ready
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    const body = await res.json() as { error?: { message?: string } }
    await shim.close()
    return { status: res.status, message: body.error?.message ?? '' }
  }

  it('points at the priced twin when one exists', async () => {
    const { status, message } = await coolingShim([
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', multiplier: 0 },
      { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', multiplier: 0.03 },
    ])
    expect(status).toBe(429)
    expect(message).toContain('deepseek-v4.1-flash-sg')
    expect(message).toContain('0.03')
    // Still a rate limit, still temporary: the hint must not turn it into a
    // re-authentication problem.
    expect(message).not.toContain('sign in')
  }, 60_000)

  it('says nothing extra when the family has no priced row', async () => {
    const { status, message } = await coolingShim([
      { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', multiplier: 0 },
    ])
    expect(status).toBe(429)
    // No invented alternative, and no dangling separator from the missing hint.
    expect(message).toContain('rate-limited for model deepseek-v4.1-flash')
    expect(message).not.toContain('paid row')
  }, 60_000)

  it('does not offer a twin for a model the catalog does not list', async () => {
    // A cooling id absent from the roster must not produce a guess.
    const { status, message } = await coolingShim([
      { id: 'unrelated', name: 'Unrelated', multiplier: 0.5 },
    ])
    expect(status).toBe(429)
    expect(message).not.toContain('paid row')
  }, 60_000)
})
