/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）
 *       dingminhua/dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）
 *   — 端点与 wire behavior（按 domain 选 CN/global base、/v2 路径、强制
 *     stream:true、tool_choice 压平为字符串、chat 请求绝不携带 refresh
 *     token 的安全红线、developer→system role 转换、刷新走独立
 *     X-Refresh-Token 头、错误分类、积分按套餐聚合）经 dingminhua 实测
 *     验证，此处沿用并适配本插件的凭据接口与多账户池。
 *
 * @module dsh-workbuddy-xdpool/upstream
 */

import type { WorkBuddyCredential } from './accounts.ts'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** Token-refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** One CLI-usable model, carrying what the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  creditMultiplier?: number
  multimodal?: boolean
  reasoning?: { supportedEfforts?: readonly string[]; defaultEffort?: string; canDisableThinking?: boolean }
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
}

/** One billing package, already normalised. */
export interface WorkBuddyCreditPackage {
  packageName: string
  remain: number
  size: number
  monthly: boolean
  refreshAtMs?: number
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  expiringSoon: number
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  /** Upstream-supplied button label; the card falls back to its own copy. */
  claimButtonText?: string
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/** Result of one upstream chat attempt. */
export type ChatStreamResult =
  | { ok: true; response: Response }
  | { ok: false; kind: UpstreamErrorKind; status: number; message: string }

export interface UpstreamClientOptions {
  /** Injectable fetch, primarily for tests. */
  fetchImpl?: typeof fetch
  /** Client version string sent to the upstream. */
  clientVersion?: string
}

/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = 'https://copilot.tencent.com'
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** Client UA the desktop CLI uses. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): 'cn' | 'global' {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...credential.uid === '' || credential.uid === undefined
      ? { 'X-No-User-Id': '1' }
      : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '' && credential.uid !== undefined) headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 * Body markers win over status, because the upstream reuses 400/200 for
 * several distinct conditions.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  // The 429 the user hits ("频率限制 / soft_rate / code 6004") routes here.
  if (status === 429) return 'soft_rate'
  if (body.includes('soft_rate') || body.includes('"code":6004') || body.includes('频率限制')) {
    return 'soft_rate'
  }
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Recognises an epoch-millisecond field and the Chinese-localised sentence
 * form, so the pool can resume exactly when the window reopens.
 */
export function parseRateLimitReset(body: string): number | undefined {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body)
  if (epochMs !== null) return Number(epochMs[1])

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const parsed = Date.parse(localized[1]!.replace(' ', 'T'))
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** Parse the upstream's `credits` string into a multiplier. */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`. */
export function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((effort): effort is string => typeof effort === 'string')
    : undefined
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : undefined
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? raw['canDisableThinking'] : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...reasoning === undefined ? {} : { reasoning },
    ...descriptionZh === undefined ? {} : { descriptionZh },
    ...descriptionEn === undefined ? {} : { descriptionEn },
    ...supportsToolCall === undefined ? {} : { supportsToolCall },
  }
}

export class WorkBuddyUpstreamClient {
  private readonly fetchImpl: typeof fetch
  private readonly clientVersion: string

  constructor(options: UpstreamClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.clientVersion = options.clientVersion ?? '2.0.4'
  }

  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), and flatten `tool_choice` into its string form.
   */
  prepareChatBody(raw: string): string {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return raw
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return raw
    const obj = body as Record<string, unknown>
    obj['stream'] = true
    delete obj['stream_options']
    if (Array.isArray(obj['messages'])) {
      for (const value of obj['messages']) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const message = value as Record<string, unknown>
        if (message['role'] === 'developer') message['role'] = 'system'
      }
    }
    const choice = obj['tool_choice']
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>
      const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
      if (type === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      } else if (type === 'auto' || type === 'required') {
        obj['tool_choice'] = type
      } else if (type === 'function') {
        const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
          ? (wrapped['function'] as Record<string, unknown>)
          : undefined
        let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
        if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
        obj['tool_choice'] = name.trim() !== '' ? name.trim() : 'auto'
      } else {
        delete obj['tool_choice']
      }
    }
    return JSON.stringify(obj)
  }

  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(
    credential: WorkBuddyCredential,
    prepared: string,
    signal?: AbortSignal,
  ): Promise<ChatStreamResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(credential),
        body: prepared,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, kind: 'server', status: 0, message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /** GET the personal model catalog, keeping the `cli` agent's models only. */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const response = await this.fetchImpl(`${chatBase(credential)}/console/enterprises/personal/models`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      ...signal === undefined ? {} : { signal },
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model)
      if (parsed !== undefined) byId.set(parsed.id, parsed)
    }
    const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
    const models = ids
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
    return models
  }

  /** Read-only credits query, aggregated by package. Does not consume credits. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const fmt = (date: Date): string => {
      const p = (n: number) => n.toString().padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const wrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof wrapper['Response'] === 'object' && wrapper['Response'] !== null
      ? wrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let nearestExpiryMs: number | undefined
    let expiringSoon = 0
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1_000_000_000_000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const num = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const monthly = num('CapacityType') === 4
      const size = monthly ? num('CycleCapacitySize') : num('CapacitySize')
      const remain = monthly ? num('CycleCapacityRemain') : num('CapacityRemain')
      const capped = remain < 0 ? 0 : remain
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly ? (cycleEndMs === undefined ? undefined : cycleEndMs + 1000) : undefined
      if (!monthly && (capped <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) continue
      total += capped
      if (expiresAtMs !== undefined) {
        if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs
        if (expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: capped,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return { total, packages, expiringSoon, ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs } }
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const num = (key: string): number => (typeof data[key] === 'number' ? data[key] as number : 0)
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: num('streak_days'),
      dailyCredit: num('daily_credit'),
      todayCredit: num('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: num('next_streak_day'),
      streakBonusDays: num('streak_bonus_days'),
      streakBonusCredit: num('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
  async credits(credential: WorkBuddyCredential): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    try {
      const data = await this.fetchCredits(credential)
      return { ok: true, data }
    } catch (error: unknown) {
      return { ok: false, message: String(error) }
    }
  }
}
