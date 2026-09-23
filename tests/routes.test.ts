/**
 * Route-registration tests.
 *
 * A route that is registered inside the teardown closure looks perfect in
 * review and in every unit test that calls the handler directly — it just never
 * mounts. The card then gets an empty response and reports a JSON parse error,
 * which is a long way from "the code is in the wrong block".
 *
 * So these tests assert the one thing that actually broke: after the routes are
 * mounted, each mutating endpoint is present in the route table.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import {
  POOL_ACCOUNT_DISABLE_PATH,
  POOL_AUTOMATION_RUN_PATH,
  POOL_CHECKIN_PATH,
  POOL_CREDIT_RESERVE_PATH,
  POOL_RESCAN_PATH,
  POOL_RESET_COOLDOWN_PATH,
  POOL_STATUS_PATH,
} from '../src/status-paths.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { registerPoolStatusRoute } from '../src/web-status.ts'

/** Write a fake auth directory holding `count` accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-routes-'))
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
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A context stand-in that records every registration, plus the mount-time disposers. */
function fakeContext(routes: Map<string, unknown>): { ctx: unknown; disposers: (() => void)[] } {
  const disposers: (() => void)[] = []
  return {
    disposers,
    ctx: {
      effect(fn: () => unknown) {
        // Real cordis runs the effect body at mount and keeps its returned
        // disposer. Calling `fn()` here is what makes the routes actually
        // register, which is precisely the behaviour under test.
        const result = fn()
        if (typeof result === 'function') disposers.push(result as () => void)
        return () => {}
      },
      webServer: {
        register(entry: { path: string; handler: unknown }) {
          routes.set(entry.path, entry.handler)
          return () => { routes.delete(entry.path) }
        },
      },
    },
  }
}

/** Mount the routes over a scanned pool and hand back the route table. */
async function mount(accounts = 1): Promise<Map<string, unknown>> {
  const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(accounts)], logger: { warn() {} } })
  await pool.scan()
  const routes = new Map<string, unknown>()
  const { ctx } = fakeContext(routes)
  registerPoolStatusRoute(ctx as never, {
    pool,
    catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
    client: new WorkBuddyUpstreamClient(),
    saveSelection() {},
    setAccountDisabled() {},
    setCreditReserve() {},
    runAutomation: async () => ({ ok: 1, failed: 0, credit: 0, energy: 0, claimed: 0 }),
  })
  return routes
}

describe('pool card route table', () => {
  it('registers every route the card calls', async () => {
    const routes = await mount()
    // The read path.
    expect(routes.has(POOL_STATUS_PATH)).toBe(true)
    // Every mutating endpoint. These are the ones that vanish silently when a
    // registration lands in the teardown closure instead of at mount time.
    for (const path of [
      POOL_RESCAN_PATH,
      POOL_RESET_COOLDOWN_PATH,
      POOL_CHECKIN_PATH,
      POOL_ACCOUNT_DISABLE_PATH,
      POOL_AUTOMATION_RUN_PATH,
      POOL_CREDIT_RESERVE_PATH,
    ]) {
      expect(routes.has(path), `${path} should be registered`).toBe(true)
    }
  })

  it('accepts a manual automation run and answers with the job result', async () => {
    const routes = await mount()
    const handler = routes.get(POOL_AUTOMATION_RUN_PATH) as (req: unknown, res: unknown) => Promise<void>
    expect(typeof handler).toBe('function')

    const res = {
      status: 0,
      body: undefined as unknown,
      writeHead(status: number) { this.status = status },
      end(payload: string) { this.body = JSON.parse(payload) },
    }
    const req = {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === 'data') setTimeout(() => { listener(Buffer.from(JSON.stringify({ job: 'tasks' }), 'utf8')) }, 0)
        if (event === 'end') setTimeout(() => { listener() }, 1)
        return req
      },
      destroy() {},
    }
    await handler(req, res)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, job: 'tasks' })
  })

  it('rejects an unknown automation job with 400 rather than running nothing', async () => {
    const routes = await mount()
    const handler = routes.get(POOL_AUTOMATION_RUN_PATH) as (req: unknown, res: unknown) => Promise<void>
    const res = {
      status: 0,
      body: undefined as unknown,
      writeHead(status: number) { this.status = status },
      end(payload: string) { this.body = JSON.parse(payload) },
    }
    const req = {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === 'data') setTimeout(() => { listener(Buffer.from(JSON.stringify({ job: 'nonsense' }), 'utf8')) }, 0)
        if (event === 'end') setTimeout(() => { listener() }, 1)
        return req
      },
      destroy() {},
    }
    await handler(req, res)
    expect(res.status).toBe(400)
  })

  it('answers a non-POST with 405', async () => {
    const routes = await mount()
    const handler = routes.get(POOL_CREDIT_RESERVE_PATH) as (req: unknown, res: unknown) => Promise<void>
    const res = {
      status: 0,
      body: undefined as unknown,
      writeHead(status: number) { this.status = status },
      end(payload: string) { this.body = JSON.parse(payload) },
    }
    await handler({ method: 'GET', headers: { origin: 'http://localhost:3000' }, on() {}, destroy() {} }, res)
    expect(res.status).toBe(405)
  })
})
