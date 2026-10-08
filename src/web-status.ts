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
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAccount, WorkBuddyAccountPool } from './accounts.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { isGatewayRejectionError, regionOf, type WorkBuddyUpstreamClient } from './upstream.ts'
import type { WorkBuddyShim } from './shim.ts'
import { isAutomationJobKind, type AutomationRunSummary, type AutomationStatus } from './scheduler.ts'
import {
  POOL_ACCOUNT_DISABLE_PATH,
  POOL_ACCOUNT_IGNORE_PATH,
  POOL_AUTOMATION_RUN_PATH,
  POOL_CATALOG_REFRESH_PATH,
  POOL_CREDIT_RESERVE_PATH,
  POOL_CHECKIN_PATH,
  POOL_MODELS_SAVE_PATH,
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebAccount,
  type PoolWebAccountToggle,
  type PoolWebAccountIgnore,
  type PoolWebAutomationJob,
  type PoolWebCreditReserve,
  type PoolWebAutomationRun,
  type PoolWebCheckin,
  type PoolWebModel,
  type PoolWebModelSelection,
  type PoolWebStatus,
  type PoolWebIgnoredAccount,
  type PoolWebCatalogSource,
  type PoolRegion,
} from './status-paths.ts'

export { POOL_ACCOUNT_DISABLE_PATH, POOL_CHECKIN_PATH, POOL_MODELS_SAVE_PATH, POOL_RESET_COOLDOWN_PATH, POOL_RESCAN_PATH, POOL_STATUS_PATH }
export type { PoolWebStatus }

/** Constructor dependencies — a narrow slice of the pool runtime. */
export interface PoolStatusRouteOptions {
  pool: WorkBuddyAccountPool
  /** One catalog per region; the card reads the one for its active tab. */
  catalogs: Readonly<Record<PoolRegion, WorkBuddyCatalog>>
  client: WorkBuddyUpstreamClient
  /** Lazily resolve the running loopback shim, when it has bound a port. */
  shim?: () => { running: boolean; baseUrl?: string }
  /**
   * The daily-points automation, when the host half has one.
   *
   * Optional so these routes still mount on a profile that assembled a pool
   * without a scheduler (the CLI and the tests do exactly that); the card then
   * reports the automation as off instead of showing a broken panel.
   */
  scheduler?: () => AutomationStatus
  /**
  /**
   * Start a manual pass, for the card's "run now" button.
   *
   * Returns whether a run STARTED, not its result: a pass takes tens of
   * seconds, so it runs in the background and the card polls the scheduler
   * status for progress and earnings.
   */
  runAutomation?: (job: string, force: boolean) => boolean
  /**
   * Persist one account's reserved-credit floor. Same settings document as every
   * other card write, so it survives a restart and is re-applied after a scan.
   * Absent without a settings service: the route then answers 503.
   */
  setCreditReserve?: (accountId: string, reserve: number) => Promise<void> | void
  /**
   * Persist the user's model selection. Provided by the host half, which owns
   * the settings section; absent when the plugin runs without a settings
   * service (the save route then reports 503 rather than pretending to work).
   */
  /**
   * Persist one region's selection. The region travels with the payload: the two
   * gateways advertise different rosters, so the domestic tab and the
   * international tab each own their list and must never overwrite each other.
   */
  saveSelection?: (region: PoolRegion, selection: PoolWebModelSelection) => Promise<void> | void
  /**
   * Persist one account switch. Same settings document as every other card
   * write, so it survives a restart and is re-applied after each re-scan.
   * Absent without a settings service: the route then answers 503.
   */
  setAccountDisabled?: (accountId: string, disabled: boolean) => Promise<void> | void
  /**
   * Throw one account out of the pool for good, or take it back.
   *
   * Backed by the plugin's own ignore file rather than the settings document,
   * because the CLI writes the same list and has no settings service. Absent
   * when the host did not wire it: the route then answers 503.
   */
  setAccountIgnored?: (accountId: string, ignored: boolean) => Promise<void> | void
  /**
   * The accounts currently ignored, for the card's "ignored" list.
   *
   * A thunk rather than a snapshot so the document always reflects the file on
   * disk, including edits made by the CLI while the card is open.
   */
  ignoredAccounts?: () => readonly PoolWebIgnoredAccount[]
  /**
   * Re-fetch the model catalog for BOTH regions and report what landed.
   *
   * Absent when the host did not wire it: the route then answers 503 rather
   * than pretending the refresh happened.
   */
  refreshCatalog?: () => Promise<{
    regions: Readonly<Record<PoolRegion, { source: PoolWebCatalogSource; models: number; error?: string }>>
  }>
}

/** Redact token-like content before it crosses to the browser. */
/**
 * A zeroed-out automation job record.
 *
 * Used when no scheduler is wired: the card renders the same shape either way,
 * so an unwired profile shows zeroes rather than a missing panel.
 */
function emptyAutomationJob(): PoolWebAutomationJob {
  return { ok: 0, failed: 0, credit: 0, energy: 0, claimed: 0 }
}

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

/**
 * Validate an untrusted selection payload.
 *
 * Returns undefined for anything malformed so the route answers 400 instead of
 * writing a partial selection into the settings file. An empty array is
 * meaningful (`enabledModelIds: []` disables every model, and the card blocks
 * saving that state) so it is preserved rather than treated as absent.
 */
function parseSelection(body: Record<string, unknown>): PoolWebModelSelection | undefined {
  const out: { enabledModelIds?: string[]; imageModelIds?: string[]; contextBudgets?: Record<string, number> } = {}
  for (const key of ['enabledModelIds', 'imageModelIds'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return undefined
    const ids: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '') return undefined
      ids.push(entry)
    }
    out[key] = ids
  }
  const budgets = body['contextBudgets']
  if (budgets !== undefined) {
    if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) return undefined
    const map: Record<string, number> = {}
    for (const [id, raw] of Object.entries(budgets as Record<string, unknown>)) {
      if (id === '') return undefined
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1000) return undefined
      map[id] = raw
    }
    out.contextBudgets = map
  }
  return out
}

/**
 * Validate the account-toggle body. Returns undefined for anything malformed so
 * the route answers 400 instead of writing a half-applied switch.
 *
 * The id must name a currently known account: accepting an arbitrary string
 * would let a stale tab (or a renamed credential) leave orphan ids in the
 * settings file that no card can ever switch back off.
 */
function parseAccountToggle(
  body: Record<string, unknown>,
  known: (id: string) => boolean,
): PoolWebAccountToggle | undefined {
  const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : ''
  const disabled = body['disabled']
  if (accountId === '' || typeof disabled !== 'boolean') return undefined
  if (!known(accountId)) return undefined
  return { accountId, disabled }
}

/**
 * Validate an ignore/unignore request.
 *
 * Two different notions of "known" apply, which is why the caller passes both:
 *
 * - ignoring requires the account to be IN THE POOL, because the card can only
 *   name an account it was just shown;
 * - un-ignoring requires the account to be ON THE IGNORE LIST instead — by
 *   definition it is not in the pool any more, so checking the pool would make
 *   the undo button impossible to use.
 */
function parseAccountIgnore(
  body: Record<string, unknown>,
  knownInPool: (id: string) => boolean,
  knownIgnored: (id: string) => boolean,
): PoolWebAccountIgnore | undefined {
  const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : ''
  const ignored = body['ignored']
  if (accountId === '' || typeof ignored !== 'boolean') return undefined
  if (ignored ? !knownInPool(accountId) : !knownIgnored(accountId)) return undefined
  return { accountId, ignored }
}

/**
 * Parse a manual-run request.
 *
 * The job name is checked against the real job list rather than passed through:
 * an unknown name would otherwise reach the scheduler and silently do nothing,
 * which reads to the user as a broken button.
 */
/**
 * Parse a reserved-credit update.
 *
 * The account must already be known, for the same reason the disable route
 * checks: an unknown id would sit in the settings file forever, attached to
 * nothing the card can act on. A negative or non-finite floor is rejected
 * rather than coerced.
 */
function parseCreditReserve(
  body: Record<string, unknown>,
  known: (id: string) => boolean,
): PoolWebCreditReserve | undefined {
  const accountId = typeof body['accountId'] === 'string' ? body['accountId'].trim() : ''
  const raw = body['reserve']
  if (accountId === '' || typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined
  if (!known(accountId)) return undefined
  return { accountId, reserve: Math.floor(raw) }
}

function parseAutomationRun(body: Record<string, unknown>): PoolWebAutomationRun | undefined {
  const job = typeof body['job'] === 'string' ? body['job'].trim() : ''
  // 'all' runs the whole ordered pass, which is what the single button means.
  if (job !== 'all' && !isAutomationJobKind(job)) return undefined
  const force = body['force']
  if (force !== undefined && typeof force !== 'boolean') return undefined
  return { job, ...force === undefined ? {} : { force } }
}

function toWebAccount(account: WorkBuddyAccount, disabled: boolean, reserve: number, reserved: boolean): PoolWebAccount {
  const now = Date.now()
  const cooling = account.cooldownUntilMs > now
  const deadUntil = account.credentialDeadUntilMs ?? 0
  const credentialDead = deadUntil > now
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
    credentialDead,
    ...credentialDead ? { credentialDeadUntil: new Date(deadUntil).toISOString() } : {},
    ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
    disabled,
    creditReserve: reserve,
    reserved,
    rateLimitHits: account.rateLimitHits,
  }
}

function toWebModel(
  model: {
    id: string
    name: string
    contextWindow: number
    maxOutputTokens: number
    nativeContextWindow: number
    multiplier?: number
    supportsImages: boolean
    tags?: readonly string[]
    supportedEfforts?: readonly string[]
  },
  selection: PoolWebModelSelection,
): PoolWebModel {
  const enabled = selection.enabledModelIds
  const budget = selection.contextBudgets?.[model.id]
  const capped = budget !== undefined && budget > 0 && budget < model.nativeContextWindow
  return {
    id: model.id,
    name: model.name,
    ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
    ...model.tags === undefined ? {} : { tags: model.tags },
    ...model.supportedEfforts === undefined || model.supportedEfforts.length === 0
      ? {}
      : { supportedEfforts: model.supportedEfforts },
    supportsImages: model.supportsImages,
    contextWindow: capped ? budget : model.nativeContextWindow,
    nativeContextWindow: model.nativeContextWindow,
    maxOutputTokens: model.maxOutputTokens,
    enabled: enabled === undefined || enabled.includes(model.id),
  }
}

/**
 * Assemble the card's status document. Per-account credits and check-in state
 * are queried live; a failing query degrades to `creditsError` / `checkinError`
 * rather than failing the whole document. Never throws.
 */
export async function poolWebStatus(
  deps: PoolStatusRouteOptions,
  region: PoolRegion = 'cn',
): Promise<PoolWebStatus> {
  // Only this region's accounts: the two gateways are separate providers, and
  // a card tab must never show the other region's credits or accounts.
  const accounts = deps.pool.list(region)
  // The tab strip always offers both gateways, matching how the plugin
  // registers its two providers: an empty region reads as "no accounts signed
  // in here yet", which is information the user wants, rather than a tab that
  // only appears after they have already done the work.
  const regions: readonly PoolRegion[] = ['cn', 'global']
  // The selection the card diffs its draft against. Sourced from the
  // catalog, which is where the settings section pushes it.
  const selection: PoolWebModelSelection = deps.catalogs[region].currentSelection()
  const rows: PoolWebAccount[] = []
  const now = Date.now()

  for (const account of accounts) {
    const row = toWebAccount(
      account,
      deps.pool.isDisabled(account.id),
      deps.pool.creditReserveOf(account.id),
      deps.pool.isReserved(account.id),
    )
    // Today's automation take for this account, when the host wired a scheduler.
    // Absent means "earned nothing today", which the card renders as silence.
    const earned = deps.scheduler?.().earningsToday[account.id]
    if (earned !== undefined) Object.assign(row, { automationToday: earned })
    // Dead sign-ins are skipped outright: the upstream already said no, so
    // re-probing them on every card refresh only adds two guaranteed 401s per
    // account (and a wall of red text the user cannot act on beyond signing in).
    if (!row.cooling && row.credentialDead !== true) {
      // Tracked locally as well as on the row: TypeScript keeps `row.credentialDead`
      // narrowed to false here, and the check-in probe below must see the mark
      // this iteration just made.
      let deadNow = false
      try {
        const credits = await deps.client.fetchCredits(account.credential)
        // Feed the pool too: the reserve check reads the last known balance, and
        // the card refresh is the most frequent place we learn it. The expiry
        // travels with it, because `expiry` mode sorts on it.
        deps.pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs)
        // A live read is proof the sign-in works, so undo any earlier dead mark
        // the same way a successful token refresh does.
        deps.pool.clearCredentialDead(account.id)
        Object.assign(row, { credits: {
          total: credits.total,
          packages: credits.packages,
          ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
          ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
        } })
      } catch (error: unknown) {
        // The gateway answering HTML 401/403 is not a transient hiccup: it is
        // the same proof of a stale sign-in that a revoked refresh token is. Mark
        // the account dead here so the mark survives past the next refresh (which
        // never sees this error when the token has not expired yet), the row goes
        // red instead of printing a paragraph, and later refreshes skip the
        // account entirely instead of earning the same 401 again.
        if (isGatewayRejectionError(error)) {
          deps.pool.penalizeCredentialDead(account.id)
          deadNow = true
          Object.assign(row, { credentialDead: true })
        }
        Object.assign(row, { creditsError: safeMessage(error) })
      }
      // A dead sign-in cannot check in either, and probing it is another
      // guaranteed 401 — so the second probe is skipped, not just folded.
      if (!deadNow) {
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
    }
    rows.push(row)
  }

  const cooling = rows.filter(row => row.cooling).length
    // "In use now" is what actually served last, not what would serve next:
    // under `balanced` the next pick is a weighted draw, so there is no fixed
    // "next account" to report. Falls back to the head of the usable list before
    // the first request of the process, when nothing has served yet.
    const lastServed = deps.pool.lastServedId()
    const firstUsable = lastServed !== undefined
      ? accounts.find(account => account.id === lastServed)
      : accounts.find(account => account.cooldownUntilMs <= now)

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

  // The automation panel reads the scheduler when one is wired, and reports the
  // feature as off otherwise: a card showing an invented schedule would be worse
  // than one that says it is not running.
  const automation: AutomationStatus = deps.scheduler?.() ?? {
    enabled: false,
    running: false,
    checkinHours: [],
    reportHours: [],
    taskHours: [],
    streakHours: [],
    travelHours: [],
    jobs: {
      checkin: emptyAutomationJob(),
      report: emptyAutomationJob(),
      tasks: emptyAutomationJob(),
      streak: emptyAutomationJob(),
      travel: emptyAutomationJob(),
    },
    claimableSeen: 0,
    earningsToday: {},
    runInProgress: false,
  }

  return {
    ok: accounts.length > 0 && cooling < accounts.length,
    accounts: rows,
    ...firstUsable === undefined ? {} : { activeAccountId: firstUsable.id },
    cooling,
    // The card edits the *user-visible* list, so it gets the selection-applied
    // view: disabled models arrive flagged rather than dropped, which is what
    // lets the row render a checkbox in its real state.
    models: deps.catalogs[region].current().map(model => toWebModel({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      nativeContextWindow: model.contextWindow,
      ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
      ...model.tags === undefined ? {} : { tags: model.tags },
      ...model.supportedEfforts === undefined ? {} : { supportedEfforts: model.supportedEfforts },
      supportsImages: model.supportsImages,
    }, selection)),
    selection,
    region,
    distribution: deps.pool.currentDistribution(),
    regions,
    shim,
    automation,
    creditReserves: deps.pool.creditReservesInOrder(),
    // The accounts thrown out of the pool. Reported on every region's document
    // (not just the one they came from) because the list is a property of the
    // machine, and the user has to be able to find an ignored account no matter
    // which tab they happen to be looking at.
    ignored: deps.ignoredAccounts?.() ?? [],
    // Where this region's list came from. The card shows a "built-in list
    // (offline)" note plus a retry when it is the static table, so a failed
    // startup fetch stops looking like the plugin deleted the user's models.
    catalogSource: deps.catalogs[region].currentSource(),
    ...deps.catalogs[region].catalogUpdatedAt() === undefined
      ? {}
      : { catalogUpdatedAt: deps.catalogs[region].catalogUpdatedAt() },
    ...deps.catalogs[region].lastFetchError() === undefined
      ? {}
      : { catalogError: safeMessage(deps.catalogs[region].lastFetchError()) },
    // Files that were on disk but did not become accounts. Reported on every
    // region's document for the same reason the ignore list is: it is a property
    // of the machine, and a short account list must be explainable from any tab.
    ...deps.pool.skippedFilesInOrder().length === 0
      ? {}
      : {
          skippedFiles: deps.pool.skippedFilesInOrder().map(entry => ({
            file: basename(entry.path),
            reason: entry.reason,
          })),
        },
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
          // The card asks for one region at a time; an unknown value falls back
          // to cn rather than 400-ing, because the tab strip is not the source
          // of truth and a typo should not blank the card.
          const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('region')
          const region: PoolRegion = requested === 'global' ? 'global' : 'cn'
          json(res, 200, await poolWebStatus(deps, region))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Re-fetch the upstream model catalog.
     *
     * Its own route, distinct from the account rescan, because that is the
     * distinction users were missing: a model list that had fallen back to the
     * static table could not be recovered from the card AT ALL — "detect
     * accounts again" only re-read the desktop snapshots, so the only way back
     * to the full roster was restarting DSH.
     *
     * POST only, loopback origin only. Returns the resulting roster size per
     * region so the card can confirm the refresh actually changed something.
     */
    const disposeCatalogRefresh = ctx.webServer.register({
      kind: 'exact',
      path: POOL_CATALOG_REFRESH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.refreshCatalog === undefined) {
          return json(res, 503, { error: 'catalog refresh is not available in this build' })
        }
        try {
          const result = await deps.refreshCatalog()
          json(res, 200, { ok: true, ...result })
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


    // Model selection is the second mutating route. It only ever writes the
    // plugin's own settings namespace, and it validates the shape here rather
    // than trusting the browser: ids must be strings and budgets must be
    // positive integers, so a malformed body cannot poison the settings file.
    const disposeModelsSave = ctx.webServer.register({
      kind: 'exact',
      path: POOL_MODELS_SAVE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.saveSelection === undefined) {
          return json(res, 503, { error: 'settings service unavailable; model selection cannot be saved' })
        }
        try {
          const body = await readJsonBody(req)
          const selection = parseSelection(body)
          if (selection === undefined) return json(res, 400, { error: 'invalid selection payload' })
          // The region travels with the payload: one tab's save must not
          // touch the other tab's list. An unknown value falls back to cn.
          const region: PoolRegion = body['region'] === 'global' ? 'global' : 'cn'
          await deps.saveSelection(region, selection)
          json(res, 200, { ok: true, region, selection })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    // Flip one account in or out of rotation. POST only, loopback origin only,
    // and the id must already be a known account — the card cannot invent one.
    const disposeAccountDisable = ctx.webServer.register({
      kind: 'exact',
      path: POOL_ACCOUNT_DISABLE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.setAccountDisabled === undefined) {
          return json(res, 503, { error: 'settings service unavailable; the account switch cannot be saved' })
        }
        try {
          const body = await readJsonBody(req)
          const known = new Set(deps.pool.list().map(account => account.id))
          const toggle = parseAccountToggle(body, id => known.has(id))
          if (toggle === undefined) return json(res, 400, { error: 'invalid account toggle payload' })
          await deps.setAccountDisabled(toggle.accountId, toggle.disabled)
          json(res, 200, { ok: true, ...toggle })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Throw one account out of the pool for good, or take it back.
     *
     * Same three guards as the disable route — POST only, loopback origin only,
     * and an explicit `accountId` — plus the semantic split in
     * {@link parseAccountIgnore}: ignoring checks the pool, un-ignoring checks
     * the ignore list.
     *
     * The credential FILE is deliberately left alone. Deleting it would sign the
     * desktop app out (the live file IS the app's current session) and would not
     * even stick, since the app rewrites it on the next sign-in. Ignoring is
     * enforced on the read side instead, which is both reversible and durable.
     */
    const disposeAccountIgnore = ctx.webServer.register({
      kind: 'exact',
      path: POOL_ACCOUNT_IGNORE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.setAccountIgnored === undefined) {
          return json(res, 503, { error: 'settings service unavailable; the ignore list cannot be saved' })
        }
        try {
          const body = await readJsonBody(req)
          const knownInPool = new Set(deps.pool.list().map(account => account.id))
          const knownIgnored = new Set((deps.ignoredAccounts?.() ?? []).map(entry => entry.id))
          const parsed = parseAccountIgnore(
            body,
            id => knownInPool.has(id),
            id => knownIgnored.has(id),
          )
          if (parsed === undefined) return json(res, 400, { error: 'invalid account ignore payload' })
          await deps.setAccountIgnored(parsed.accountId, parsed.ignored)
          json(res, 200, { ok: true, ...parsed })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    /**
     * Run one automation job on demand.
     *
     * POST only, loopback origin only, and the job name must be one of the four
     * real jobs, so the card cannot name an arbitrary job. This exists so the
     * automation is verifiable without waiting for its scheduled hour.
     */
    const disposeAutomationRun = ctx.webServer.register({
      kind: 'exact',
      path: POOL_AUTOMATION_RUN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.runAutomation === undefined) {
          return json(res, 503, { error: 'automation is not available in this build' })
        }
        try {
          const body = await readJsonBody(req)
          const run = parseAutomationRun(body)
          if (run === undefined) return json(res, 400, { error: 'invalid automation run payload' })
          // Start, do not await: the pass runs for tens of seconds and the card
          // polls the status document for progress and earnings. Holding this
          // request open would time out and read as a hung button.
          const started = deps.runAutomation(run.job, run.force === true)
          json(res, 200, { ok: true, job: run.job, started })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })


    /**
     * Set or clear one account's reserved-credit floor.
     *
     * POST only, loopback origin only, and the id must already be a known
     * account: the card cannot invent an id, and a stale tab must not leave
     * orphan keys in the settings file.
     */
    const disposeCreditReserve = ctx.webServer.register({
      kind: 'exact',
      path: POOL_CREDIT_RESERVE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (deps.setCreditReserve === undefined) {
          return json(res, 503, { error: 'settings service unavailable; the reserve cannot be saved' })
        }
        try {
          const body = await readJsonBody(req)
          const known = new Set(deps.pool.list().map(account => account.id))
          const parsed = parseCreditReserve(body, id => known.has(id))
          if (parsed === undefined) return json(res, 400, { error: 'invalid credit reserve payload' })
          await deps.setCreditReserve(parsed.accountId, parsed.reserve)
          json(res, 200, { ok: true, ...parsed })
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })

    return () => {
      disposeAutomationRun()
      disposeCreditReserve()
      disposeAccountIgnore()
      disposeCatalogRefresh()
      disposeCheckin()
      disposeAccountDisable()
      disposeModelsSave()
      disposeReset()
      disposeRescan()
      disposeStatus()
    }
  }, 'dsh-workbuddy-xdpool: Web status route')
}
