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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyAccountPool } from './accounts.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { parseRateLimitReset, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.ts'

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
 *  "input length too long"). Surfaced as a friendly hint, never auto-truncated. */
function isContextTooLong(body: string): boolean {
  if (body.includes('context_length_exceeded')) return true
  if (body.includes('input length too long')) return true
  if (body.includes('"code":11115')) return true
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
  return false
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
    let exhaustedByRateLimit = false

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      const account = await pool.acquire(modelId)
      if (account === undefined) {
        // Distinguish "never signed in" from "every account is rate-limited":
        // they need opposite remedies, so they must not share a status code.
        if (exhaustedByRateLimit && last !== undefined) {
          const subject = modelId === undefined
            ? 'every WorkBuddy account is rate-limited'
            : `every account is rate-limited for model ${modelId}`
          writeOpenAIError(
            res,
            KIND_STATUS[last.kind],
            last.kind,
            `${subject} (tried ${tried.length}: ${tried.join(', ')}); ` +
              `resets at the upstream window — ${last.message.slice(0, 200)}`,
          )
          return
        }
        writeOpenAIError(
          res,
          401,
          'not_signed_in',
          'no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)',
        )
        return
      }
      tried.push(account.label)

      const result = await client.chatStream(account.credential, prepared, controller.signal)

      if (result.ok) {
        logger?.info?.(`dsh-workbuddy-xdpool: served by ${account.label}`)
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
        return
      }

      last = { kind: result.kind, status: result.status, message: result.message }

      // A dead session is recoverable: refresh the token and retry the request.
      if (result.kind === 'session_dead') {
        logger?.warn(`dsh-workbuddy-xdpool: ${account.label} session dead; refreshing token and retrying`)
        await pool.refreshAccount(account.id)
        continue
      }

      // Rotate only on rate limits; other failures are terminal for this request.
      if (result.kind !== 'soft_rate') break

      exhaustedByRateLimit = true
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
    // A context-window overrun is a clear, actionable condition — surface a
    // friendly hint instead of a bare upstream echo. The provider must NOT
    // silently truncate or summarise the user's conversation (that drops
    // context and can answer wrongly); the right move is telling the user.
    if (isContextTooLong(last.message)) {
      const subject = modelId === undefined
        ? 'the conversation exceeds this model\'s context window'
        : `the conversation exceeds ${modelId}'s context window`
      writeOpenAIError(
        res,
        400,
        'context_length_exceeded',
        `${subject}. Shorten the conversation, start a new chat, or pick a model with a larger window ` +
          `(e.g. hy4-preview).`,
      )
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
