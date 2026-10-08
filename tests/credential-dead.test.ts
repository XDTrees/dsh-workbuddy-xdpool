/**
 * A credential the upstream has REVOKED must stop absorbing the retry budget.
 *
 * The reported symptom: the pool card showed a wall of red English text for
 * several accounts ("the WorkBuddy gateway rejected this credential (http 401)
 * … sign in again"), and requests failed even though other accounts in the same
 * pool were perfectly healthy.
 *
 * The mechanism is not obvious from the outside, because a revoked token keeps a
 * FUTURE `expiresAtMs` — the upstream never rewrites a stored expiry when it
 * drops a session. So the credential file looks valid, `available()` returns it,
 * the shim answers `session_dead`, refreshes the token, gets the same dead token
 * back, and tries again — up to `maxAttempts` times, always on the same account.
 * Healthy accounts were never reached.
 *
 * `invalid_grant: Offline user session not found` is the upstream's own words
 * for "this refresh token is gone", and it is the only reliable signal available.
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

/** The exact upstream rejection seen in the field for the three dead CN accounts. */
const REVOKED = 'workbuddy upstream session_dead (http 401): 12153:refresh token failed:'
  + '400 Bad Request: invalid_grant: Offline user session not found'

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-dead-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        // Comfortably in the FUTURE: this is what made the dead account
        // invisible to the expiry gate in the first place.
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

/** A pool whose token refresher rejects `deadTokens` the way the upstream does. */
function poolWithRefresher(authDir: string, deadTokens: readonly string[]): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({
    authDirs: [authDir],
    logger: { warn() {}, info() {}, error() {} },
    client: {
      async refreshToken(credential) {
        if (deadTokens.includes(credential.accessToken)) throw new Error(REVOKED)
        return { accessToken: `fresh-${credential.accessToken}`, expiresInSec: 3600 }
      },
    },
  })
}

describe('a revoked sign-in is proven dead, not retried forever', () => {
  it('marks the account dead when the refresh token was revoked upstream', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(1), ['token-0'])
    await pool.scan()
    const account = pool.list()[0]!

    // Before: nothing is known about the credential.
    expect(pool.deadCredentials()).toHaveLength(0)

    const recovered = await pool.refreshAccount(account.id, { force: true })
    expect(recovered).toBe(false)
    expect(pool.deadCredentials().map(a => a.id)).toEqual([account.id])
  })

  it('does NOT call a transient network failure a dead credential', async () => {
    // The opposite mistake is worse: a DNS blip would take a healthy account
    // out of rotation for 30 minutes, which looks exactly like a lost account.
    const pool = new WorkBuddyAccountPool({
      authDirs: [await fakeAuthDir(1)],
      logger: { warn() {}, info() {}, error() {} },
      client: { async refreshToken() { throw new Error('fetch failed') } },
    })
    await pool.scan()
    const account = pool.list()[0]!

    expect(await pool.refreshAccount(account.id, { force: true })).toBe(true)
    expect(pool.deadCredentials()).toHaveLength(0)
  })

  it('keeps serving from the healthy account while a dead one sits in the pool', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(2), ['token-0'])
    await pool.scan()
    const dead = pool.list().find(a => a.credential.accessToken === 'token-0')!
    await pool.refreshAccount(dead.id, { force: true })

    // Whatever the order, the dead account must never come back.
    for (let i = 0; i < 5; i += 1) {
      const picked = await pool.acquire('hy4-preview', 'cn')
      expect(picked).toBeDefined()
      expect(picked!.id).not.toBe(dead.id)
    }
  })

  it('reports session_dead (not "nothing signed in") when every account was revoked', async () => {
    // The two states need opposite remedies: one means "sign in again", the
    // other means "your files are fine, the upstream dropped them".
    const pool = poolWithRefresher(await fakeAuthDir(2), ['token-0', 'token-1'])
    await pool.scan()
    for (const account of pool.list()) await pool.refreshAccount(account.id, { force: true })

    const why = pool.unavailableReason('hy4-preview', 'cn')
    expect(why.reason).toBe('session_dead')
    expect(why.dead).toBe(2)
    expect(why.total).toBe(2)
    // Not misreported as a cooldown: waiting does not fix a revoked token.
    expect(why.cooling).toBe(0)
  })

  it('revives the account once the user signs in again', async () => {
    const dir = await fakeAuthDir(1)
    const pool = poolWithRefresher(dir, ['token-0'])
    await pool.scan()
    const account = pool.list()[0]!
    await pool.refreshAccount(account.id, { force: true })
    expect(pool.deadCredentials()).toHaveLength(1)

    // A fresh desktop login rewrites the live file with a NEW refresh token
    // (and a later expiry, which is what makes it "fresher" than what we hold).
    await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: {
        accessToken: 'token-new',
        refreshToken: 'refresh-new',
        expiresAt: Date.now() + 7_200_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-0-${'0'.repeat(24)}`, uin: '100000000000', nickname: 'Account0' },
    }), 'utf8')

    await pool.scan()
    expect(pool.deadCredentials()).toHaveLength(0)
    expect(pool.list()[0]!.credential.refreshToken).toBe('refresh-new')
  })

  it('puts every dead account back on the card\'s "clear all cooldowns" button', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(1), ['token-0'])
    await pool.scan()
    await pool.refreshAccount(pool.list()[0]!.id, { force: true })
    expect(pool.deadCredentials()).toHaveLength(1)

    pool.resetCooldowns()
    expect(pool.deadCredentials()).toHaveLength(0)
    expect(pool.status().dead).toBe(0)
  })
})

describe('the shim rotates away from a dead account instead of burning every attempt', () => {
  /** 401 + HTML for the revoked tokens, a normal SSE stream for everything else. */
  function deadFetch(deadTokens: readonly string[], hits: string[]) {
    return (async (_url: unknown, init: RequestInit): Promise<Response> => {
      const headers = init.headers as Record<string, string>
      const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
      hits.push(token)
      if (deadTokens.includes(token)) {
        return new Response('<html><head><title>401 Authorization Required</title></head></html>', {
          status: 401,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  it('serves the request from a healthy account after the first one is revoked', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(2), ['token-0'])
    await pool.scan()
    const hits: string[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: deadFetch(['token-0'], hits) })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    // The dead account is out of rotation, and the request did not spend every
    // attempt on it: exactly one 401 was seen, then the healthy account served.
    expect(pool.deadCredentials()).toHaveLength(1)
    expect(hits.filter(token => token === 'token-0')).toHaveLength(1)
  })

  it('answers 401 session_dead — never "not signed in" — when the whole pool was revoked', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(2), ['token-0', 'token-1'])
    await pool.scan()
    const hits: string[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: deadFetch(['token-0', 'token-1'], hits) })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), region: 'cn' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await response.json() as { error?: { code?: string; message?: string } }

    expect(response.status).toBe(401)
    expect(body.error?.code).toBe('session_dead')
    expect(body.error?.message ?? '').toContain('sign in again')
    // Each dead account is tried at most once — not `maxAttempts` times each.
    expect(hits.filter(token => token === 'token-0')).toHaveLength(1)
    expect(hits.filter(token => token === 'token-1')).toHaveLength(1)
  })

  it('does not re-probe a dead account on every card refresh', async () => {
    const pool = poolWithRefresher(await fakeAuthDir(1), ['token-0'])
    await pool.scan()
    await pool.refreshAccount(pool.list()[0]!.id, { force: true })

    let probes = 0
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => { probes += 1; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch,
    })
    const status = await poolWebStatus({
      pool,
      catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
      client,
    })

    // The card still shows the row, flagged, with no upstream call at all.
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0]!.credentialDead).toBe(true)
    expect(status.accounts[0]!.creditsError).toBeUndefined()
    expect(probes).toBe(0)
  })
})
