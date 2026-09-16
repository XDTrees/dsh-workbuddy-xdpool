/**
 * Same-origin routes backing the WorkBuddy XD Pool settings card.
 *
 * These answer loopback browser requests only and never carry token material
 * (no access/refresh tokens, no uin). Read-only by default — the status route
 * is a GET; the card's rescan and cooldown-reset actions are explicit POSTs.
 * The one mutating route is the daily check-in claim, which is guarded by an
 * explicit per-account `accountId` and a pre-claim status re-check.
 *
 * Mounted on the Host's `webServer` (same-origin as the DSH settings UI) via
 * `ctx.inject(['webServer'], ...)` in `apply`. Because `webServer` is an
 * optional service, a headless profile without it simply never mounts these
 * routes and the card degrades to an offline banner — the provider keeps
 * serving models regardless.
 *
 * @module dsh-workbuddy-xdpool/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAccount, WorkBuddyAccountPool } from './accounts.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyShim } from './shim.ts'
import {
  POOL_CHECKIN_PATH,
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebAccount,
  type PoolWebCheckin,
  type PoolWebModel,
  type PoolWebStatus,
} from './status-paths.ts'

export { POOL_CHECKIN_PATH, POOL_RESET_COOLDOWN_PATH, POOL_RESCAN_PATH, POOL_STATUS_PATH }
export type { PoolWebStatus }

/** Constructor dependencies — a narrow read-only slice of the pool runtime. */
export interface PoolStatusRouteOptions {
  pool: WorkBuddyAccountPool
  catalog: WorkBuddyCatalog
  client: WorkBuddyUpstreamClient
  /** Lazily resolve the running loopback shim, when it has bound a port. */
  shim?: () => { running: boolean; baseUrl?: string }
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** Smallest possible POST body reader, capped so a hung or oversized body
 *  cannot pin memory on the Host. Returns `{}` for an empty body. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const LIMIT = 64 * 1024
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function toWebAccount(account: WorkBuddyAccount): PoolWebAccount {
  const now = Date.now()
  const cooling = account.cooldownUntilMs > now
  const modelCooldowns = Object.entries(account.modelCooldowns)
    .filter(([, until]) => until > now)
    .sort((a, b) => a[1] - b[1])
    .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }))
  return {
    id: account.id,
    label: account.label,
    ...account.credential.nickname === undefined ? {} : { nickname: account.credential.nickname },
    domain: account.credential.domain,
    ...account.credential.expiresAtMs === 0
      ? {}
      : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
    cooling,
    ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
    ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
    rateLimitHits: account.rateLimitHits,
  }
}

function toWebModel(model: {
  id: string
  name: string
  contextWindow: number
  multiplier?: number
  supportsImages: boolean
  tags?: readonly string[]
}): PoolWebModel {
  return {
    id: model.id,
    name: model.name,
    ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
    ...model.tags === undefined ? {} : { tags: model.tags },
    supportsImages: model.supportsImages,
    contextWindow: model.contextWindow,
  }
}

/**
 * Assemble the card's status document. Per-account credits and check-in state
 * are queried live; a failing query degrades to `creditsError` / `checkinError`
 * rather than failing the whole document. Never throws.
 */
export async function poolWebStatus(deps: PoolStatusRouteOptions): Promise<PoolWebStatus> {
  const accounts = deps.pool.list()
  const now = Date.now()
  const rows: PoolWebAccount[] = []

  for (const account of accounts) {
    const row = toWebAccount(account)
    if (!row.cooling) {
      try {
        const credits = await deps.client.fetchCredits(account.credential)
        Object.assign(row, { credits: {
          total: credits.total,
          packages: credits.packages,
          ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
          ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
        } })
      } catch (error: unknown) {
        Object.assign(row, { creditsError: safeMessage(error) })
      }
      try {
        const checkin = await deps.client.fetchCheckinStatus(account.credential)
        const web: PoolWebCheckin = {
          active: checkin.active,
          todayCheckedIn: checkin.todayCheckedIn,
          streakDays: checkin.streakDays,
          dailyCredit: checkin.dailyCredit,
          todayCredit: checkin.todayCredit,
          isStreakDay: checkin.isStreakDay,
          nextStreakDay: checkin.nextStreakDay,
          streakBonusCredit: checkin.streakBonusCredit,
        }
        Object.assign(row, { checkin: web })
      } catch (error: unknown) {
        Object.assign(row, { checkinError: safeMessage(error) })
      }
    }
    rows.push(row)
  }

  const cooling = rows.filter(row => row.cooling).length
  const firstUsable = accounts.find(account => account.cooldownUntilMs <= now)

  let shim: { running: boolean; baseUrl?: string }
  if (deps.shim === undefined) {
    shim = { running: false }
  } else {
    try {
      shim = deps.shim()
    } catch {
      shim = { running: false }
    }
  }

  return {
    ok: accounts.length > 0 && cooling < accounts.length,
    accounts: rows,
    ...firstUsable === undefined ? {} : { activeAccountId: firstUsable.id },
    cooling,
    models: deps.catalog.current().map(toWebModel),
    shim,
  }
}

/**
 * Mount the read-only routes on a context where `webServer` is available. The
 * caller uses `ctx.inject(['webServer'], ...)` so Desktop startup order cannot
 * make this registration disappear.
 */
export function registerPoolStatusRoute(ctx: Context, deps: PoolStatusRouteOptions): void {
  ctx.effect(() => {
    const disposeStatus = ctx.webServer.register({
      kind: 'exact',
      path: POOL_STATUS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        try {
          json(res, 200, await poolWebStatus(deps))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeRescan = ctx.webServer.register({
      kind: 'exact',
      path: POOL_RESCAN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        try {
          const accounts = await deps.pool.scan()
          json(res, 200, { accounts: accounts.length })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    const disposeReset = ctx.webServer.register({
      kind: 'exact',
      path: POOL_RESET_COOLDOWN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        deps.pool.resetCooldowns()
        json(res, 200, { ok: true })
      },
    })

    // The only mutating route: it collects a daily reward, so it is guarded on
    // three axes — POST only, loopback origin only, and an explicit `accountId`
    // body field. An ambiguous request can never claim on the wrong account
    // (and never on every account at once).
    const disposeCheckin = ctx.webServer.register({
      kind: 'exact',
      path: POOL_CHECKIN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        try {
          const body = await readJsonBody(req)
          const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : ''
          if (accountId === '') return json(res, 400, { error: 'accountId is required' })
          const account = deps.pool.list().find(item => item.id === accountId)
          if (account === undefined) return json(res, 404, { error: 'unknown account' })
          const before = await deps.client.fetchCheckinStatus(account.credential)
          // Second guard: never re-claim a reward the status already reports as
          // collected. Protects against a double-click or a stale card.
          if (!before.active) return json(res, 409, { error: 'check-in activity is not active' })
          if (before.todayCheckedIn) {
            return json(res, 200, { ok: true, alreadyCheckedIn: true, claim: { credit: 0, streakDays: before.streakDays, isStreakDay: before.isStreakDay } })
          }
          const claim = await deps.client.claimDailyCheckin(account.credential)
          json(res, 200, { ok: true, claim })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    return () => {
      disposeCheckin()
      disposeReset()
      disposeRescan()
      disposeStatus()
    }
  }, 'dsh-workbuddy-xdpool: Web status route')
}
