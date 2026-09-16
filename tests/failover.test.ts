/**
 * Failover behaviour tests.
 *
 * These cover the reason this plugin exists: a `429 soft_rate` from one account
 * must rotate to the next account inside the same request, and an exhausted
 * pool must surface a clear sign-in error instead of a generic turn failure.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { classifyUpstreamError, parseRateLimitReset, WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-'))
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
    // One live file plus one rotated snapshot, to exercise both discovery paths.
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A fetch stub that rate-limits the first `failures` accounts, then succeeds. */
function rotationFetch(failures: number, state: { hit: string[] }) {
  // A rate-limit reset in the near FUTURE so a penalized account actually
  // enters cooldown (a stale past timestamp would leave it perpetually usable).
  const resetAt = new Date(Date.now() + 10 * 60 * 1000)
  const resetText = `${resetAt.getFullYear()}-${String(resetAt.getMonth() + 1).padStart(2, '0')}-${String(resetAt.getDate()).padStart(2, '0')} ${String(resetAt.getHours()).padStart(2, '0')}:${String(resetAt.getMinutes()).padStart(2, '0')}:${String(resetAt.getSeconds()).padStart(2, '0')}`
  return async (_url: unknown, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>
    const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
    state.hit.push(token)
    const index = Number(token.split('-')[1])
    if (index < failures) {
      return new Response(
        JSON.stringify({ code: 6004, msg: `您的使用量已超出频率限制，将在 ${resetText} UTC+8 重置` }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
}

describe('upstream classification', () => {
  it('classifies http 429 as soft_rate', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
  })

  it('classifies the in-body rate limit marker even on http 200', () => {
    expect(classifyUpstreamError(200, '{"code":6004,"msg":"频率限制"}')).toBe('soft_rate')
  })

  it('parses the localized reset timestamp', () => {
    const reset = parseRateLimitReset('您的使用量已超出频率限制，将在 2026-09-04 15:14:46 UTC+8 重置')
    expect(reset).toBeTypeOf('number')
    expect(new Date(reset as number).getUTCFullYear()).toBe(2026)
  })
})

describe('account pool', () => {
  it('discovers every distinct account once', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(3)] })
    const accounts = await pool.scan()
    expect(accounts).toHaveLength(3)
    expect(new Set(accounts.map(a => a.id)).size).toBe(3)
  })

  it('skips a cooling account and uses the next one', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)] })
    const accounts = await pool.scan()
    const [first, second] = accounts
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const before = await pool.acquire()
    pool.penalize(before!.id)
    const after = await pool.acquire()
    expect(after!.id).not.toBe(before!.id)
  })

  it('rescans and recovers when every account is cooling', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const only = (await pool.acquire())!
    pool.penalize(only.id)
    expect(await pool.acquire()).toBeUndefined()
    pool.resetCooldowns()
    expect(await pool.acquire()).toBeDefined()
  })

  it('prefers the explicitly selected account when it is usable', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(3)] })
    const accounts = await pool.scan()
    const target = accounts[1]!
    pool.prefer(target.id)
    const acquired = await pool.acquire()
    expect(acquired!.id).toBe(target.id)
  })

  it('refreshes a near-expiry token on acquire, deduplicated per account', async () => {
    const dir = await fakeAuthDir(1)
    // Rewrite the account's access token to expire in seconds so acquire refreshes.
    const pool = new WorkBuddyAccountPool({
      authDirs: [dir],
      client: {
        async refreshToken(credential) {
          return { accessToken: `fresh-${credential.uin ?? 'x'}`, expiresInSec: 3600 }
        },
      },
      refreshMarginMs: 5 * 60 * 1000,
    })
    await pool.scan()
    // Mutate the discovered credential to be near-expiry.
    const account = pool.list()[0]!
    account.credential = { ...account.credential, expiresAtMs: Date.now() + 1000 }
    const acquired = await pool.acquire()
    expect(acquired!.credential.accessToken).toMatch(/^fresh-/)
    // The refreshed token was kept on the account for subsequent requests.
    expect(pool.list()[0]!.credential.accessToken).toMatch(/^fresh-/)
  })
})

describe('shim failover', () => {
  it('rotates to a healthy account when one is rate-limited', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(3)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({ fetchImpl: rotationFetch(2, { hit: [] }) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    // The first two accounts were rate-limited and the third served the request.
    // A 429 cools per (account, model), so the penalty lands in `modelCooldowns`
    // rather than in the account-wide `cooldownUntilMs`: the account itself
    // stays usable for every other model.
    const coolingForModel = pool.list()
      .filter(a => (a.modelCooldowns['hy4-preview'] ?? 0) > Date.now())
    expect(coolingForModel).toHaveLength(2)
    expect(pool.list().every(a => a.cooldownUntilMs === 0)).toBe(true)
  })

  it('returns 429 only after every account is exhausted', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({ fetchImpl: rotationFetch(99, { hit: [] }) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog(), maxAttempts: 4 })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('soft_rate')
    expect(body.error.message).toContain('Account0')
  })

  it('rejects a request without the shim secret', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: rotationFetch(0, { hit: [] }) as never }),
      catalog: new WorkBuddyCatalog(),
    })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ model: 'hy4-preview', messages: [] }),
    })
    expect(response.status).toBe(401)
  })

  it('refreshes a dead session and retries the same request', async () => {
    const dir = await fakeAuthDir(1)
    const pool = new WorkBuddyAccountPool({
      authDirs: [dir],
      refreshMarginMs: 60 * 60 * 1000,
      client: {
        async refreshToken() {
          return { accessToken: 'fresh-token', expiresInSec: 3600 }
        },
      },
    })
    await pool.scan()
    // The account token starts expired so acquire triggers a refresh.
    pool.list()[0]!.credential = { ...pool.list()[0]!.credential, expiresAtMs: Date.now() - 1000 }

    // Upstream: any token except the refreshed one is a dead session; the
    // refreshed token succeeds.
    const state: { hits: number } = { hits: 0 }
    const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
      state.hits += 1
      const headers = init.headers as Record<string, string>
      const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
      if (token !== 'fresh-token') {
        return new Response(JSON.stringify({ code: 12153, msg: 'Offline user session not found' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: fetchImpl as never }),
      catalog: new WorkBuddyCatalog(),
    })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
  })
})

describe('adapter', () => {
  it('points every model at the shim and hides the real token', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: rotationFetch(0, { hit: [] }) as never }),
      catalog: new WorkBuddyCatalog(),
    })
    shims.push(shim)
    await shim.ready

    // The real pi-ai adapter is constructed; models must all target the shim
    // and never embed an account token.
    const adapter = createWorkBuddyAdapter({ shim, catalog: new WorkBuddyCatalog() })
    const models = adapter.buildModels()

    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect((model as Record<string, unknown>)['baseUrl']).toBe(`${shim.baseUrl()}/v1`)
      expect((model as Record<string, unknown>)['provider']).toBe('workbuddy-xdpool')
      expect(JSON.stringify(model)).not.toContain('token-')
    }

    // The shim secret must be the apiKey the provider resolves, not an account token.
    expect(typeof adapter.adapter).toBe('object')
    expect(shim.token()).not.toContain('token-')
    expect(shim.token().length).toBeGreaterThan(0)
  })
})
