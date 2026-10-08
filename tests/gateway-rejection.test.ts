/**
 * A gateway that answers HTML 401 is the same evidence a revoked refresh token
 * is: the sign-in is gone, and waiting will not bring it back.
 *
 * The reported symptom was cosmetic but the cause was not. Three accounts on the
 * card each printed the whole paragraph the upstream helper throws —
 * "the WorkBuddy gateway rejected this credential (http 401) … sign in again …"
 * — because the card refresh caught the failure and put the message on the row.
 * Behind the wall of text, every refresh re-probed all three accounts and earned
 * the same 401 twice each (credits *and* check-in), forever: the pool's own dead
 * mark was only ever set from the token-refresh path, which never runs while the
 * stored token has not expired yet.
 *
 * So these tests pin both halves: the mark is set from the card's probe (and the
 * second probe is skipped), and a failure that is NOT the gateway's — a DNS blip,
 * a timeout — must never be mistaken for one, because that would silently drop a
 * healthy account out of rotation for half an hour.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { isGatewayRejectionError, WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { poolWebStatus } from '../src/web-status.ts'

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-gw-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        // Comfortably in the future: this is exactly why the refresh path — the
        // only one that used to set the dead mark — never gets a turn.
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

async function pool(count: number): Promise<WorkBuddyAccountPool> {
  const instance = new WorkBuddyAccountPool({
    authDirs: [await fakeAuthDir(count)],
    logger: { warn() {}, info() {}, error() {} },
  })
  await instance.scan()
  return instance
}

/** What openresty answers when it no longer honours the credential. */
function htmlRejection(): Response {
  return new Response(
    '<html><head><title>401 Authorization Required</title></head>'
    + '<body><center>openresty</center></body></html>',
    { status: 401, headers: { 'Content-Type': 'text/html' } },
  )
}

/** A healthy billing envelope with one one-off pack. */
function creditsOk(): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: [{
            PackageName: 'one-off',
            CapacityType: 1,
            CapacitySize: 100,
            CapacityRemain: 50,
            ExpiredTime: new Date(Date.now() + 86_400_000).toISOString(),
          }],
        },
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function catalogs(): { cn: WorkBuddyCatalog; global: WorkBuddyCatalog } {
  return { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() }
}

describe('telling a gateway rejection apart from a hiccup', () => {
  it('recognises the message the upstream helper throws', () => {
    expect(isGatewayRejectionError(new Error(
      'the WorkBuddy gateway rejected this credential (http 401). This usually means the '
      + 'account is using a stale sign-in the upstream no longer accepts: sign in again …',
    ))).toBe(true)
  })

  it('does not claim a network failure or a plain 500 was a stale sign-in', () => {
    // The opposite mistake is the expensive one: a DNS blip would take a healthy
    // account out of rotation for half an hour, which looks like a lost account.
    expect(isGatewayRejectionError(new Error('fetch failed'))).toBe(false)
    expect(isGatewayRejectionError(new Error('workbuddy upstream returned non-JSON (http 500): oops'))).toBe(false)
    expect(isGatewayRejectionError(new Error('workbuddy upstream error (http 429): soft_rate'))).toBe(false)
    expect(isGatewayRejectionError('not an error object')).toBe(false)
  })
})

describe('a gateway rejection marks the sign-in dead instead of printing a paragraph', () => {
  /** Route the billing probes by path so each can be counted separately. */
  function billingFetch(credits: () => Response, urls: string[], checkin?: () => Response) {
    return (async (url: unknown) => {
      const href = String(url)
      urls.push(href)
      if (href.includes('get-user-resource')) return credits()
      if (href.includes('checkin-activity-status')) return checkin === undefined ? htmlRejection() : checkin()
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }

  it('flags the row, marks the account dead, and skips the second probe', async () => {
    const instance = await pool(1)
    const urls: string[] = []
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: billingFetch(htmlRejection, urls),
    })

    const status = await poolWebStatus({ pool: instance, catalogs: catalogs(), client })

    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0]!.credentialDead).toBe(true)
    // The full sentence still travels with the row — the card folds it into a
    // marker with this as the tooltip — so the reason is not lost.
    expect(status.accounts[0]!.creditsError ?? '').toContain('gateway rejected this credential')
    // The pool now knows, so the shim rotates past it instead of spending the
    // retry budget on it.
    expect(instance.deadCredentials().map(a => a.id)).toEqual([status.accounts[0]!.id])
    // Check-in cannot succeed for a dead sign-in, so it is not asked at all:
    // exactly one upstream call, not the two-per-refresh the report complained about.
    expect(urls.filter(href => href.includes('get-user-resource'))).toHaveLength(1)
    expect(urls.filter(href => href.includes('checkin-activity-status'))).toHaveLength(0)
  })

  it('leaves a plain network failure alone, even though the row still reports it', async () => {
    const instance = await pool(1)
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch,
    })

    const status = await poolWebStatus({ pool: instance, catalogs: catalogs(), client })

    expect(status.accounts[0]!.credentialDead).toBe(false)
    expect(status.accounts[0]!.creditsError).toBe('fetch failed')
    expect(instance.deadCredentials()).toHaveLength(0)
  })

  it('does not spend the second probe on an account already known dead', async () => {
    const instance = await pool(1)
    instance.penalizeCredentialDead(instance.list()[0]!.id)
    let probes = 0
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => { probes += 1; return creditsOk() }) as unknown as typeof fetch,
    })

    const status = await poolWebStatus({ pool: instance, catalogs: catalogs(), client })

    expect(status.accounts[0]!.credentialDead).toBe(true)
    expect(status.accounts[0]!.creditsError).toBeUndefined()
    expect(probes).toBe(0)
  })

  it('reports live credits again once the user signs in again', async () => {
    const dir = await fakeAuthDir(1)
    const instance = new WorkBuddyAccountPool({
      authDirs: [dir],
      logger: { warn() {}, info() {}, error() {} },
    })
    await instance.scan()

    const rejecting = new WorkBuddyUpstreamClient({ fetchImpl: billingFetch(htmlRejection, []) })
    const first = await poolWebStatus({ pool: instance, catalogs: catalogs(), client: rejecting })
    expect(first.accounts[0]!.credentialDead).toBe(true)

    // The desktop app writes a NEW refresh token, which is the one signal that
    // revives a rejected account — without it the dead mark would outlive the
    // very fix it is waiting for.
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
    await instance.scan()

    const urls: string[] = []
    const healthy = new WorkBuddyUpstreamClient({ fetchImpl: billingFetch(creditsOk, urls) })
    const second = await poolWebStatus({ pool: instance, catalogs: catalogs(), client: healthy })

    expect(second.accounts[0]!.credentialDead).toBe(false)
    expect(second.accounts[0]!.creditsError).toBeUndefined()
    expect(second.accounts[0]!.credits?.total).toBe(50)
    expect(instance.deadCredentials()).toHaveLength(0)
  })
})

describe('the card folds a probe failure into a marker, never a paragraph', () => {
  it('renders the check-in failure the same way as the credits failure', async () => {
    // Both messages can be the gateway's whole sentence, so both must become a
    // short marker with the text in the tooltip — printing one of them inline
    // buries the panel it belongs to under four lines of English.
    const { readFileSync } = await import('node:fs')
    const card = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'PoolCard.tsx'), 'utf8')
    const locales = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'locales.ts'), 'utf8')

    // `>{…}<` is the printed-as-text shape; the tooltip reference must stay.
    expect(card, 'the raw check-in message must not be printed').not.toContain('>{account.checkinError}<')
    expect(card).toContain('title={account.checkinError}')
    expect(card).toContain("t?.('row.checkinUnavailable')")
    // Both languages, or the fold shows the English fallback to a zh user.
    expect(locales.match(/'row\.checkinUnavailable':/g)?.length ?? 0).toBe(2)
  })
})
