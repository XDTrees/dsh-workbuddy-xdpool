/**
 * Daily check-in tests.
 *
 * The check-in block is the one place in the pool that spends a reward, so the
 * behaviour that matters is safety: a claim must name exactly one account, it
 * must never double-collect, and a failing upstream probe must degrade to an
 * error field instead of taking the whole card document down.
 *
 * `web-status.ts` talks to a narrow slice of the pool runtime, so these tests
 * drive the real route table with a fake `webServer` and a fake upstream.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { POOL_CHECKIN_PATH, poolWebStatus, registerPoolStatusRoute } from '../src/web-status.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-checkin-'))
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
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-05T00-00-00-000Z.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** Upstream check-in state shared by the fakes. */
function checkinPayload(todayCheckedIn: boolean): string {
  return JSON.stringify({
    code: 0,
    data: {
      active: true,
      today_checked_in: todayCheckedIn,
      streak_days: 9,
      daily_credit: 100,
      today_credit: todayCheckedIn ? 100 : 0,
      is_streak_day: false,
      next_streak_day: 12,
      streak_bonus_days: 7,
      streak_bonus_credit: 500,
      claim_button_text: '立即签到',
    },
  })
}

/** Minimal Response stand-in for the injected fetch. */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

/** A minimal stand-in for the cordis Context: the route registrar only needs
 *  `effect` (to scope its disposers) and `webServer.register`. */
function fakeContext(routes: Map<string, (req: unknown, res: unknown) => Promise<void> | void>): unknown {
  return {
    effect(fn: () => unknown) {
      fn()
      return () => {}
    },
    webServer: {
      register(entry: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        routes.set(entry.path, entry.handler)
        return () => {}
      },
    },
  }
}

/** Fake ServerResponse capturing what the handler wrote. */
function fakeResponse(): {
  status: number
  body: unknown
  writeHead(status: number): void
  end(payload: string): void
} {
  return {
    status: 0,
    body: undefined,
    writeHead(status: number) { this.status = status },
    end(payload: string) {
      try {
        this.body = JSON.parse(payload)
      } catch {
        this.body = payload
      }
    },
  }
}

/** A POST request carrying a small JSON body. */
function fakeRequest(body: unknown, origin = 'http://localhost:3000'): unknown {
  const text = body === undefined ? '' : JSON.stringify(body)
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
  const req = {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    on(event: string, listener: (arg?: unknown) => void) {
      ;(listeners[event] ??= []).push(listener)
      return req
    },
    destroy() {},
  }
  // Flush on the next tick so the handler can attach its listeners first.
  setTimeout(() => {
    if (listeners['data'] !== undefined) for (const fn of listeners['data']) fn(Buffer.from(text, 'utf8'))
    if (listeners['end'] !== undefined) for (const fn of listeners['end']) fn()
  }, 0)
  return req
}

describe('check-in status', () => {
  it('carries per-account check-in state, including the upstream button label', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse(checkinPayload(false))) as never,
    })

    const status = await poolWebStatus({ pool, catalog: new WorkBuddyCatalog(), client })
    expect(status.accounts).toHaveLength(2)
    for (const row of status.accounts) {
      expect(row.checkin).toMatchObject({
        active: true,
        todayCheckedIn: false,
        streakDays: 9,
        dailyCredit: 100,
        nextStreakDay: 12,
        streakBonusCredit: 500,
      })
    }
  })

  it('degrades a failing check-in probe to checkinError without failing the document', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse('nope', 500)) as never,
    })

    const status = await poolWebStatus({ pool, catalog: new WorkBuddyCatalog(), client })
    // The account row still renders; only the check-in field reports the failure.
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0]!.checkin).toBeUndefined()
    expect(status.accounts[0]!.checkinError).toBeDefined()
  })

  it('never exposes token material through the check-in fields', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse(checkinPayload(true))) as never,
    })

    const status = await poolWebStatus({ pool, catalog: new WorkBuddyCatalog(), client })
    const serialized = JSON.stringify(status)
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\./u)
    expect(serialized).not.toContain('token-0')
    expect(serialized).not.toContain('refresh-0')
  })
})

describe('check-in route', () => {
  it('mounts the check-in path alongside the existing routes', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, {
      pool,
      catalog: new WorkBuddyCatalog(),
      client: new WorkBuddyUpstreamClient({ fetchImpl: (async () => jsonResponse(checkinPayload(false))) as never }),
    })
    expect([...routes.keys()]).toContain(POOL_CHECKIN_PATH)
  })

  it('claims on the named account and reports the collected credit', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(3)] })
    await pool.scan()
    const target = pool.list()[2]!
    let claimedBody: unknown
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('daily-checkin')) {
          claimedBody = JSON.parse(String(init?.body ?? '{}'))
          return jsonResponse(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 10, is_streak_day: false } }))
        }
        return jsonResponse(checkinPayload(false))
      }) as never,
    })

    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, { pool, catalog: new WorkBuddyCatalog(), client })

    const res = fakeResponse()
    await routes.get(POOL_CHECKIN_PATH)!(fakeRequest({ accountId: target.id }), res)
    expect(res.status).toBe(200)
    expect((res.body as { claim?: { credit?: number } }).claim?.credit).toBe(100)
    // The request body is the upstream's own `{}`: the account id never travels
    // upstream, it only selected which credential signed the call.
    expect(claimedBody).toEqual({})
  })

  it('refuses a claim without an explicit accountId', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse(checkinPayload(false))) as never,
    })
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, { pool, catalog: new WorkBuddyCatalog(), client })

    const res = fakeResponse()
    await routes.get(POOL_CHECKIN_PATH)!(fakeRequest({}), res)
    expect(res.status).toBe(400)
  })

  it('refuses an unknown account id', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse(checkinPayload(false))) as never,
    })
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, { pool, catalog: new WorkBuddyCatalog(), client })

    const res = fakeResponse()
    await routes.get(POOL_CHECKIN_PATH)!(fakeRequest({ accountId: 'nope' }), res)
    expect(res.status).toBe(404)
  })

  it('never double-collects: an already-checked-in account short-circuits', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const target = pool.list()[0]!
    let claimCalls = 0
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).includes('daily-checkin')) {
          claimCalls += 1
          return jsonResponse(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 9, is_streak_day: false } }))
        }
        return jsonResponse(checkinPayload(true))
      }) as never,
    })
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, { pool, catalog: new WorkBuddyCatalog(), client })

    const res = fakeResponse()
    await routes.get(POOL_CHECKIN_PATH)!(fakeRequest({ accountId: target.id }), res)
    expect(res.status).toBe(200)
    expect((res.body as { alreadyCheckedIn?: boolean }).alreadyCheckedIn).toBe(true)
    // The reward endpoint was never touched.
    expect(claimCalls).toBe(0)
  })

  it('rejects a non-loopback origin', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => jsonResponse(checkinPayload(false))) as never,
    })
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    registerPoolStatusRoute(fakeContext(routes) as never, { pool, catalog: new WorkBuddyCatalog(), client })

    const res = fakeResponse()
    const req = fakeRequest({ accountId: pool.list()[0]!.id }, 'http://evil.example.com')
    await routes.get(POOL_CHECKIN_PATH)!(req, res)
    expect(res.status).toBe(403)
  })
})
