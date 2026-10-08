/**
 * Loopback OpenAI-compatible endpoint with multi-account failover.
 *
 * The pi-ai provider points here. Each chat request acquires an account from
 * the pool; when the upstream answers with a rate limit, the shim cools that
 * account down, takes the next one, and retries in the same request — so a
 * `429 soft_rate` never reaches the user as a turn failure.
 *
 * Security model (Host/Origin loopback checks, constant-time bearer compare,
 * random port, in-process secret, body cap, error→status mapping) follows
 * corrinehu/dsh-workbuddy-connect (MIT, Copyright (c) 2026 Corrine Hu), which
 * designed and validated it.
 *
 * @module dsh-workbuddy-xdpool/shim
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyAccount, WorkBuddyAccountPool } from './accounts.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { parseRateLimitReset, WorkBuddyUpstreamClient, type ChatStreamResult, type UpstreamErrorKind, type WorkBuddyRegion } from './upstream.ts'
import { compactWithSummary, estimateMessagesTokens, hardTruncate, type ChatMessage } from './context-budget.ts'
import { paidAlternativeFor } from './siblings.ts'

export interface ShimLogger {
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WorkBuddyShim {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

export interface WorkBuddyShimOptions {
  pool: WorkBuddyAccountPool
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * Restrict this shim to one gateway. Two shims run side by side — one
   * per region — and each must only ever draw accounts that belong to its
   * own gateway. Absent means "every account" (a single-region deployment).
   */
  region?: WorkBuddyRegion
  /** Max accounts to try per request before giving up. */
  maxAttempts?: number
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host must name loopback; drops DNS-rebinding attempts before routing. */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat POSTs must carry a JSON body type (blocks simple-request CSRF). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** True when an upstream failure body means the request overran the model's
 *  context window (OpenAI `context_length_exceeded`, WorkBuddy code 11115 /
 *  "input length too long"). The shim answers it by compacting the conversation
 *  in place and retrying once; see `recoverFromContextOverrun`. */
function isContextTooLong(body: string): boolean {
  if (body.includes('context_length_exceeded')) return true
  if (body.includes('input length too long')) return true
  if (body.includes('"code":11115')) return true
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
  return false
}

/**
 * A content-free description of a request, for the log when the upstream
 * rejects it.
 *
 * `model_param_invalid` arrives with an EMPTY `param` field, so the error alone
 * says nothing about which parameter was rejected — the user is left with "the
 * request parameters do not meet the current model requirements" and no way to
 * act. Recording the shape (top-level keys, message count by role, tool count,
 * approximate prompt size) makes such a rejection diagnosable from the log.
 *
 * Deliberately SHAPE ONLY: no message content, no tool schemas, no tokens. It
 * ends up in a log file, and the conversation it describes is the user's.
 */
function requestShape(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys = Object.keys(parsed).sort()
    const messages = Array.isArray(parsed['messages']) ? parsed['messages'] as unknown[] : []
    const byRole = new Map<string, number>()
    let chars = 0
    for (const entry of messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      const role = typeof message['role'] === 'string' ? message['role'] : '?'
      byRole.set(role, (byRole.get(role) ?? 0) + 1)
      // Approximate only; the point is the ORDER of magnitude.
      chars += JSON.stringify(message['content'] ?? '').length
    }
    const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(' ')
    const tools = Array.isArray(parsed['tools']) ? parsed['tools'].length : 0
    return `keys=[${keys.join(' ')}] messages=${messages.length}${roles === '' ? '' : ` (${roles})`} `
      + `tools=${tools} contentChars=${chars}`
  } catch {
    return 'body was not parseable JSON'
  }
}

/**
 * Stable identity of the conversation a request belongs to, for `sticky`.
 *
 * The FIRST user message is the key: it is the one part of the body that does
 * not change as the history grows, so every turn of a conversation hashes the
 * same way while a new chat (with a different opening message) hashes
 * differently. Hashing rather than storing the text keeps conversation content
 * out of the pool's memory.
 *
 * Two conversations that open with the exact same message share an account —
 * rare, and harmless: it only means they share one account's prompt cache.
 */
function conversationKeyOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return undefined
    for (const entry of parsed.messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      if (message['role'] !== 'user') continue
      const content = typeof message['content'] === 'string'
        ? message['content']
        : JSON.stringify(message['content'] ?? '')
      return createHash('sha256').update(content).digest('hex').slice(0, 32)
    }
    return undefined
  } catch {
    return undefined
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { pool, client, catalog } = options
  const region = options.region
  const logger = options.logger
  const maxAttempts = options.maxAttempts ?? 8

  // Per-process secret. The adapter resolves this as the OpenAI apiKey; the
  // shim never forwards it, because the real token comes from the pool.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1] as string)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  /**
   * "The same model has a paid row" sentence for a 429 body, or undefined.
   *
   * Reads the catalog the shim was built with, so the hint names a row this
   * gateway ACTUALLY serves — a CN-only id in a global 429 would be worse than
   * no hint at all. Absent when the cooling model is itself paid, or when the
   * family has no priced twin.
   */
  function paidTwinHint(modelId: string): string | undefined {
    const models = catalog.current()
    const model = models.find(candidate => candidate.id === modelId)
    if (model === undefined) return undefined
    const twin = paidAlternativeFor(model, models)
    if (twin === undefined) return undefined
    return `${twin.id} is the same model on a paid row (x${twin.multiplier.toFixed(2)} credits) `
      + 'and is rate-limited separately; switch to it to keep going'
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  /**
   * Last balance refresh per account, so a busy account is not probed on
   * every request. Ten minutes is well inside the window where ordinary use
   * could cross a reserve.
   */
  const lastBalanceAt = new Map<string, number>()
  const BALANCE_REFRESH_MS = 10 * 60 * 1000

  /**
   * Refresh one account known credit balance, best effort.
   *
   * Runs in the background after a successful request. Failures are swallowed
   * on purpose: a reserve is a safety feature, and a flaky balance lookup must
   * never become a failed user request or a noisy log.
   */
  async function refreshBalance(account: WorkBuddyAccount): Promise<void> {
    const now = Date.now()
    const last = lastBalanceAt.get(account.id) ?? 0
    if (now - last < BALANCE_REFRESH_MS) return
    lastBalanceAt.set(account.id, now)
    try {
      const credits = await client.fetchCredits(account.credential)
      // The expiry travels with the balance: `expiry` mode sorts on it, and a
      // balance read is the only place we ever learn it.
      pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs)
    } catch {
      // Keep the previous reading; the next request tries again.
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, pool: pool.status() })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(error))
      else res.end()
    }
  }

  /**
   * Serve one chat completion, rotating accounts on rate limits.
   *
   * A rate-limited account is cooled for exactly the window the upstream
   * reports (when parseable) and the next account is tried immediately, so a
   * pool with any healthy member never surfaces a 429 to the caller.
   */
  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = client.prepareChatBody(raw)
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    // `sticky` binds each conversation to one account; the pool ignores this
    // under every other distribution.
    const conversationKey = conversationKeyOf(raw)

    // The request's target model. The upstream rate limit is per-model ("可切换
    // 其他模型继续使用"), so cooldowns are keyed by (account, model): a 429 on
    // `hy4-preview` only cools that model on the account, never the whole one.
    let modelId: string | undefined
    try {
      const parsed = JSON.parse(raw) as { model?: unknown }
      modelId = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
    } catch {
      modelId = undefined
    }

    const tried: string[] = []
    let last: { kind: UpstreamErrorKind; status: number; message: string } | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      const account = await pool.acquire(modelId, region, conversationKey)
      if (account === undefined) {
        // Ask the POOL why, instead of inferring it from this request alone.
        //
        // The old check used a flag set earlier IN THIS LOOP, which cannot see a
        // cooldown that was established by an earlier request. After a 429, the
        // next request found no account on its first attempt, the flag was still
        // false, and the shim answered 401 "no credential found; sign in" — so
        // DSH showed an "API key invalid" panel for a model that was merely
        // cooling, sending the user to re-authenticate over a temporary limit.
        const why = pool.unavailableReason(modelId, region)

        if (why.reason === 'cooling') {
          // A rate limit is TEMPORARY: the caller should wait, not re-authenticate.
          const subject = modelId === undefined
            ? 'every WorkBuddy account is rate-limited'
            : `every account is rate-limited for model ${modelId}`
          const upstream = last === undefined ? '' : ` — ${last.message.slice(0, 200)}`
          // The gateway limits each ROW of a product line separately, so a
          // cooling free row usually has a working paid twin. Without this the
          // user's only move is to wait; naming the twin gives them a way out
          // that costs a little rather than nothing.
          const twin = modelId === undefined ? undefined : paidTwinHint(modelId)
          writeOpenAIError(
            res,
            429,
            'soft_rate',
            `${subject} (${why.cooling}/${why.total} cooling, tried ${tried.length})`
              + `${tried.length === 0 ? '' : `: ${tried.join(' → ')}`}${upstream}`
              + (twin === undefined ? '' : ` — ${twin}`),
          )
          return
        }

        if (why.reason === 'disabled') {
          writeOpenAIError(
            res,
            403,
            'no_enabled_account',
            `all ${why.total} WorkBuddy account(s) for this gateway are switched off or ignored; `
              + 're-enable one on the pool card',
          )
          return
        }

        if (why.reason === 'reserve') {
          writeOpenAIError(
            res,
            402,
            'reserve_floor',
            `every WorkBuddy account is at or below its credit reserve (${why.total} account(s)); `
              + 'lower the reserve on the pool card or top up credits',
          )
          return
        }

        if (why.reason === 'session_dead') {
          // Distinct from "never signed in": these accounts HAVE credentials, the
          // upstream just refuses them now. Waiting does not help, and saying
          // "no credential found" would send the user looking for a missing file.
          writeOpenAIError(
            res,
            401,
            'session_dead',
            `${why.dead}/${why.total} WorkBuddy account(s) for this gateway were rejected by the upstream `
              + '(their sign-in was revoked); sign in again in the WorkBuddy desktop app to restore them',
          )
          return
        }

        writeOpenAIError(
          res,
          401,
          'not_signed_in',
          why.total === 0
            ? 'no WorkBuddy credential found for this gateway; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)'
            : `no usable WorkBuddy credential among ${why.total} account(s) for this gateway; sign in again on the desktop app`,
        )
        return
      }
      tried.push(account.label)

      const result = await client.chatStream(account.credential, prepared, controller.signal)

      if (result.ok) {
        await serveSuccessfulStream(res, account, result, logger, refreshBalance, pool)
        return
      }

      last = { kind: result.kind, status: result.status, message: result.message }

      // A dead session is only recoverable when the refresh token still works.
      // `refreshAccount` asks the upstream and reports back: `true` means the
      // token was renewed (retry the request), `false` means the upstream
      // confirmed the credential is revoked. In that case the account is cooled
      // so the next attempt rotates instead of landing on it again — without
      // this, every one of `maxAttempts` hit the same dead account while healthy
      // accounts were never tried.
      if (result.kind === 'session_dead') {
        logger?.warn(`dsh-workbuddy-xdpool: ${account.label} session dead; refreshing token and retrying`)
        const before = account.credential.accessToken
        const recovered = await pool.refreshAccount(account.id, { force: true })
        // A 401 on a token the upstream still hands out refresh credentials for
        // is only "maybe stale". Once the refresh comes back with the SAME token
        // (or fails outright) there is nothing left to try: treat it as dead so
        // the retry budget goes to the other accounts instead of this one.
        if (!recovered || account.credential.accessToken === before) {
          pool.penalizeCredentialDead(account.id)
          logger?.warn(
            `dsh-workbuddy-xdpool: ${account.label} sign-in is no longer valid `
              + `(attempt ${attempt + 1}/${maxAttempts}); rotating`,
          )
        }
        continue
      }

      // Credit exhaustion is an ACCOUNT condition, not a model one: every model on
      // that account is dead until its quota resets, so cool the whole account and
      // rotate. Failing the request here would waste the other healthy accounts.
      if (result.kind === 'hard_credit') {
        pool.penalizeExhausted(account.id)
        logger?.warn(
          `dsh-workbuddy-xdpool: ${account.label} has no credits left `
            + `(attempt ${attempt + 1}/${maxAttempts}); rotating`,
        )
        continue
      }

      // A `client` failure (HTTP 400) names no parameter when the upstream
      // leaves `extError.param` empty, which is the usual case — the user then
      // gets "the request parameters do not meet the current model requirements"
      // and nothing else. Log the SHAPE of what we sent (keys and counts only,
      // never message content) so the next occurrence is diagnosable from the
      // log instead of requiring a reproduction.
      if (result.kind === 'client') {
        logger?.warn(
          `dsh-workbuddy-xdpool: ${account.label} rejected the request as invalid `
          + `(model ${modelId ?? '(none)'}) — ${requestShape(raw)}; upstream: ${result.message.slice(0, 300)}`,
        )
      }

      // Other failures are terminal for this request.
      if (result.kind !== 'soft_rate') break

      // Cool only this model on this account; the account's other models stay
      // usable (the upstream explicitly allows switching to another model).
      pool.penalize(account.id, parseRateLimitReset(result.message), modelId)
      logger?.warn(
        `dsh-workbuddy-xdpool: ${account.label} rate-limited on ${modelId ?? '(no model)'} ` +
          `(attempt ${attempt + 1}/${maxAttempts}); rotating`,
      )
    }

    if (last === undefined) {
      writeOpenAIError(res, 500, 'internal', 'chat request exhausted without a result')
      return
    }
    // A context-window overrun has two layers of defence, and this is the inner
    // one. The Harness runs its own `compaction-basic` BEFORE dispatch, driven by
    // the context window each model advertises — but that window is a guess for
    // an upstream routed through a shim, so a prompt can still arrive too large.
    // When it does, compact in place here and retry once; if even that cannot fit,
    // emit the message the Harness classifies as an overflow (see
    // `contextOverflowMessage`) so its OUTER recovery path gets a chance to
    // shrink the history and retry at the agent level.
    //
    // The two layers are complementary, not redundant: this one keeps a single
    // turn alive without the Harness ever seeing a failure, and the outer one
    // survives the case where a shim-side compaction still will not fit.
    if (isContextTooLong(last.message)) {
      const recovered = await recoverFromContextOverrun({
        raw,
        modelId,
        controller,
        region,
        logger,
        client,
        pool,
        maxAttempts,
        contextWindow: modelId === undefined
          ? undefined
          : catalog.current().find(m => m.id === modelId)?.contextWindow,
      })
      if (recovered.ok) {
        await serveSuccessfulStream(res, recovered.account, recovered.result, logger, refreshBalance, pool)
        return
      }
      // The wording is a contract with the Harness; see `contextOverflowMessage`.
      writeOpenAIError(res, 400, 'context_length_exceeded', contextOverflowMessage(modelId, recovered.detail))
      return
    }
    writeOpenAIError(
      res,
      KIND_STATUS[last.kind],
      last.kind,
      `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(' → ')}]: ${last.message.slice(0, 400)}`,
    )
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections()
        server.once('error', reject)
      }),
  }
}

/**
 * Build the overflow message the Harness must recognize.
 *
 * This is deliberately NOT free-form prose. `dsh-compaction-basic` decides
 * whether to compact-and-retry by running the text that reaches it through
 * `isContextWindowExceededError()` (`@deepseek-ai/dsh-llm`), whose matcher
 * accepts only specific phrasings:
 *
 *   - `context_length_exceeded` / `context window exceeded`
 *   - `maximum context length`
 *   - `<input|prompt|request|messages> too large|long for ... context`
 *   - `<input|prompt|request> exceeds the ... context window`
 *
 * The obvious friendly sentence ("the conversation exceeds this model's
 * context window") matches NONE of them, and neither does the WorkBuddy
 * upstream's own "input length too long" / code 11115. Emitting either meant
 * the Harness saw an unclassifiable 400, skipped its recovery path, and
 * surfaced a dead turn — the bug this function exists to prevent.
 *
 * The leading clause carries the machine-matched wording; the trailing clause
 * is what a human reads. Keep both in sync with
 * `tests/context-overflow-contract.test.ts`.
 */
export function contextOverflowMessage(modelId: string | undefined, detail = ''): string {
  const subject = modelId === undefined ? 'the model' : `model ${modelId}`
  const note = detail === '' ? '' : ` (${detail})`
  return `This model's maximum context length was exceeded: the prompt is too large for `
    + `${subject}, and the conversation could not be compacted in place${note}. `
    + `Compact the conversation, or start a new chat.`
}

/**
 * Serve one already-successful upstream stream as an SSE response.
 *
 * Extracted so the context-overrun recovery path reuses the exact same
 * bookkeeping (noteServed + background balance refresh) as a first-try hit.
 */
async function serveSuccessfulStream(
  res: ServerResponse,
  account: WorkBuddyAccount,
  result: Extract<ChatStreamResult, { ok: true }>,
  logger: ShimLogger | undefined,
  refreshBalance: (account: WorkBuddyAccount) => Promise<void>,
  pool: WorkBuddyAccountPool,
): Promise<void> {
  logger?.info?.(`dsh-workbuddy-xdpool: served by ${account.label}`)
  // Only now is this account the one actually serving the user: a request
  // that failed over to another account must not mark the tried one as used.
  pool.noteServed(account.id)
  // Refresh the balance in the background so the reserved-credit floor has a
  // fresh reading. Deliberately NOT awaited: the response is already ready and
  // a balance lookup must never delay the user's stream.
  void refreshBalance(account)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let sawDone = false
  const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    if (chunk.includes('[DONE]')) sawDone = true
  })
  body.on('error', (error: unknown) => {
    logger?.warn('dsh-workbuddy-xdpool: upstream stream failed mid-flight', error)
    if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
  })
  body.pipe(res)
}

export interface RecoverOptions {
  raw: string
  modelId: string | undefined
  controller: AbortController
  region: WorkBuddyRegion | undefined
  logger: ShimLogger | undefined
  client: WorkBuddyUpstreamClient
  pool: WorkBuddyAccountPool
  maxAttempts: number
  /** True context window for the model, so the budget fits the real limit. */
  contextWindow?: number
}

export type RecoverResult =
  | { ok: true; account: WorkBuddyAccount; result: Extract<ChatStreamResult, { ok: true }> }
  | { ok: false; detail: string }

/**
 * Compact an over-long conversation and retry it once.
 *
 * Strategy, in order:
 *  1. drop the oldest turns, keeping system messages and the newest exchange;
 *  2. ask the model to summarise the dropped turns and splice that summary in;
 *  3. hard-truncate as a last resort.
 *
 * Returns `ok: false` only when even a truncated prompt still overran — the
 * caller then surfaces the original actionable 400.
 */
async function recoverFromContextOverrun(options: RecoverOptions): Promise<RecoverResult> {
  const { raw, modelId, controller, region, logger, client, pool, maxAttempts } = options
  const parsed = client.parseChatBody(raw)
  if (parsed === undefined) return { ok: false, detail: 'request body was not parseable JSON' }
  const rawMessages = parsed['messages']
  if (!Array.isArray(rawMessages)) return { ok: false, detail: 'request carried no messages array' }
  const messages = rawMessages.filter(
    (value): value is ChatMessage => typeof value === 'object' && value !== null && !Array.isArray(value),
  )
  if (messages.length === 0) return { ok: false, detail: 'request carried no usable messages' }

  // The upstream reports the overrun but not the window size, so the budget has
  // to be derived from evidence rather than from the catalog alone.
  const overrunTokens = estimateMessagesTokens(messages)
  // Use the model's REAL context window when known (from the catalog); only
  // fall back to half the prompt when it is unknown.
  //
  // …but NEVER trust it as an upper bound, which is the bug this fixes: the
  // catalog advertises `deepseek-v4.1-flash` at 1M, so the budget computed to
  // 0.8 * 1M - 2048 = 797952 while the rejected prompt was already 791793
  // tokens. Compacting "to" a target LARGER than the prompt changed nothing, the
  // retry overran again, and the log line looked like the recovery had run.
  //
  // The prompt in hand just overran, so it is a hard, EVIDENCE-BASED ceiling:
  // whatever the catalog claims, the budget must sit meaningfully below it.
  const realWindow = options.contextWindow
  const fromWindow = realWindow !== undefined && realWindow > 0
    ? Math.max(512, Math.floor(realWindow * 0.8) - 2048)
    : Number.POSITIVE_INFINITY
  // Half the failing prompt: its size is known to be too big, so halving it both
  // guarantees real shrinkage and leaves headroom for the answer.
  const fromOverrun = Math.max(512, Math.floor(overrunTokens / 2))
  const budget = Math.min(fromWindow, fromOverrun)

  logger?.warn(
    `dsh-workbuddy-xdpool: context overrun on ${modelId ?? '(no model)'} `
      + `(~${overrunTokens} tokens, catalog window ${realWindow ?? 'unknown'}); `
      + `compacting to ~${budget} and retrying once`,
  )

  let summary: string | undefined
  let compacted: ChatMessage[] = messages
  let compactionDetail = ''
  try {
    const summariser = await pool.acquire(modelId, region)
    if (summariser === undefined) {
      compactionDetail = 'no account available to summarise with'
    } else {
      const outcome = await compactWithSummary(
        messages,
        { budget, keepRecent: 6 },
        {
          complete: async (request, signal) => {
            const body = client.buildChatBody(
              { ...parsed, stream: true, max_tokens: Math.max(256, Math.floor(budget / 2)) },
              request,
            )
            return await client.completeChat(summariser.credential, body, signal ?? controller.signal)
          },
        },
        controller.signal,
      )
      compacted = outcome.messages
      summary = outcome.summary
      if (outcome.skipped !== undefined) compactionDetail = outcome.skipped
    }
  } catch (error: unknown) {
    // Summarisation is best-effort; fall through to truncation.
    compactionDetail = `summarisation failed: ${String(error)}`
  }

  // Whatever the summariser managed, make sure the prompt now fits.
  if (estimateMessagesTokens(compacted) > budget) {
    compacted = hardTruncate(compacted, budget).messages
  }
  if (summary === undefined && estimateMessagesTokens(compacted) >= overrunTokens) {
    return { ok: false, detail: compactionDetail === '' ? 'compaction could not reduce the prompt' : compactionDetail }
  }

  const retryBody = client.buildChatBody(parsed, compacted)
  const tried: string[] = []
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (controller.signal.aborted) return { ok: false, detail: 'client disconnected' }
    const account = await pool.acquire(modelId, region)
    if (account === undefined) return { ok: false, detail: 'no account available after compaction' }
    tried.push(account.label)
    const result = await client.chatStream(account.credential, retryBody, controller.signal)
    if (result.ok) {
      logger?.info?.(
        `dsh-workbuddy-xdpool: recovered from context overrun on ${modelId ?? '(no model)'} `
          + `(summarised: ${summary === undefined ? 'no' : 'yes'})`,
      )
      return { ok: true, account, result }
    }
    if (isContextTooLong(result.message)) {
      // Still too long even after compaction: give up rather than loop.
      return { ok: false, detail: 'prompt still exceeded the window after compaction' }
    }
    if (result.kind === 'session_dead') {
      // Same rule as the main loop: try a refresh, and if the credential is
      // proven dead cool it so this retry budget is not spent on it again.
      const before = account.credential.accessToken
      const recovered = await pool.refreshAccount(account.id, { force: true })
      if (!recovered || account.credential.accessToken === before) pool.penalizeCredentialDead(account.id)
      continue
    }
    if (result.kind === 'hard_credit') {
      pool.penalizeExhausted(account.id)
      continue
    }
    if (result.kind === 'soft_rate') {
      pool.penalize(account.id, parseRateLimitReset(result.message), modelId)
      continue
    }
    return { ok: false, detail: `upstream ${result.kind} after compaction` }
  }
  return { ok: false, detail: `no account served the compacted request (tried ${tried.length})` }
}
