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
  /** Upstream image-input flag. Both gateways spell it `supportsImages`; some entries
   * also carry `disabledMultimodal`, the negative spelling. Reading anything else
   * reported every model as text-only, which made a vision shim register a second
   * route under the same display name and split the model picker group.
   */
  supportsImages?: boolean
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
/** Client UA the desktop CLI uses — the CN gateway answers this one. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * Desktop app UA. The global gateway serves its product config only to this
 * client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
 * is why the international catalog must be read with the desktop spelling.
 */
const DESKTOP_UA = 'WorkBuddy/5.5.2'

/** CN model catalog. */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = '/v3/config'
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
/** The two gateways WorkBuddy serves: the domestic one and the international one. */
export type WorkBuddyRegion = 'cn' | 'global'

/**
 * Hosts the international product answers on, once each has been stripped of a
 * leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
 * the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
 * CLI signs the same international account in at `codebuddy.ai`. All are served
 * by one gateway stack, so all are `global` — missing a spelling sends those
 * tokens to the CN gateway, which rejects them at the openresty layer with an
 * HTML 401 instead of a business JSON error.
 */
const GLOBAL_HOSTS: readonly string[] = ['workbuddy.ai', 'workbuddy.cc', 'codebuddy.ai']

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): 'cn' | 'global' {
  const lowered = domain.trim().toLowerCase()
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return 'global'
  }
  return 'cn'
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
 * versa, so the base must follow the credential's own domain rather than one
 * hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
 */
function globalBase(credential: WorkBuddyCredential): string {
  const lowered = credential.domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_BILLING_BASE
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

/**
 * Gateway denials that arrive as an HTML page rather than a JSON envelope.
 *
 * openresty / APISIX reject a request before it reaches the product when the
 * credential is one the gateway no longer honours — most often a stale sign-in
 * left in the auth directory. The status alone (401) is not actionable and the
 * HTML body leaks nothing useful, so this turns it into a sentence the user can
 * act on.
 */
function isGatewayHtmlRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const head = text.slice(0, 512).toLowerCase()
  return head.includes('<html') || head.includes('openresty') || head.includes('apisix')
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  if (isGatewayHtmlRejection(response.status, text)) {
    throw new Error(
      'the WorkBuddy gateway rejected this credential (http 401). This usually means the ' +
      'account is using a stale sign-in the upstream no longer accepts: sign in again in ' +
      'the WorkBuddy desktop app, then pick the account on the plugin card. ' +
      'Run `dsh-workbuddy-xdpool doctor` to list every credential found.',
    )
  }
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
/**
 * The effort ladder the upstream's plural-form payloads declare across both
 * gateways (the live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level of it on
 * singular-form models — medium/xhigh fold into high, low/max answer with their
 * own budgets — so a singular `effort` value is a DEFAULT, never the model's
 * only level.
 */
const SINGULAR_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * True when `reasoning` arrives in the singular spelling: an `effort` string,
 * with none of the plural-form fields alongside it. Seen on CN
 * `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
 * `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Probes on both gateways show these models answer with
 * distinct `reasoning_content` across the whole ladder — and do not think at
 * all when no `reasoning_effort` is sent — so the fold widens
 * `supportedEfforts` and carries the declared value into `defaultEffort`. An
 * unrecognized `effort` passes through as the lone level.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to
 * `undefined`. Both spellings normalize here: the plural form passes through as
 * declared, and the singular `effort` form folds via
 * {@link singularEffortLadder}.
 */
export function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const singularForm = isSingularEffortForm(raw)
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string'
    ? raw['defaultEffort']
    : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : singularForm ? true : undefined
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
  const supportsImages = typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
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
    ...supportsImages === undefined ? {} : { supportsImages },
  }
}

/** One growth-centre task, flattened from the upstream's loosely-shaped entry. */
export interface WorkBuddyTask {
  /** Upstream task code; the claim path is built from it. */
  taskCode: string
  title: string
  /** Reward in credits, when the task declares one. */
  credit: number
  /** Reward in energy, when the task declares one. */
  energy: number
  /** Whether the task carries any reward at all. */
  hasReward: boolean
  /** Progress target; 0 is a valid value (a task with no counter). */
  target: number
  /** Current progress; 0 is a valid value. */
  current: number
  /** Upstream enrolment state: not_accepted / accepted / claimed. */
  acceptStatus: string
  /** Upstream task state, e.g. `complete`. */
  status: string
  /** Progress reached its target and the reward is still outstanding. */
  claimable: boolean
  /** Reward already collected. */
  claimed: boolean
  /** Upstream marked the task locked (not yet reachable). */
  locked: boolean
}

/**
 * Flatten one upstream task entry.
 *
 * Progress is reported two ways depending on the task: flat `current`/`target`
 * fields, or a nested `progress: {current, target}`. The nested form wins when
 * it carries anything, because a task that reports both puts the live counter
 * there. Entries without a usable `task_code` are dropped — without one the
 * claim path cannot be built.
 */
function parseTask(value: unknown): WorkBuddyTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const taskCode = typeof raw['task_code'] === 'string' ? raw['task_code'] : ''
  if (taskCode === '') return undefined

  const num = (key: string): number => (typeof raw[key] === 'number' ? raw[key] as number : 0)
  let current = num('current')
  let target = num('target')
  const progress = raw['progress']
  if (typeof progress === 'object' && progress !== null) {
    const nested = progress as Record<string, unknown>
    const nestedCurrent = typeof nested['current'] === 'number' ? nested['current'] as number : 0
    const nestedTarget = typeof nested['target'] === 'number' ? nested['target'] as number : 0
    if (nestedTarget > 0 || nestedCurrent > 0) {
      current = nestedCurrent
      target = nestedTarget
    }
  }

  const acceptStatus = typeof raw['accept_status'] === 'string' ? raw['accept_status'] : ''
  const claimed = acceptStatus === 'claimed'
  return {
    taskCode,
    title: typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : taskCode,
    credit: num('reward_credit'),
    energy: num('reward_energy'),
    hasReward: raw['has_reward'] === true,
    target,
    current,
    acceptStatus,
    status: typeof raw['status'] === 'string' ? raw['status'] : '',
    claimable: !claimed && target > 0 && current >= target,
    claimed,
    locked: raw['locked'] === true,
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

  /**
   * Fetch the model catalog, keeping the `cli` agent's models only.
   *
   * The two gateways are read differently, because they answer differently:
   *
   * - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
   *   the CLI client spelling.
   * - **Global** serves it as part of the product config at `/v3/config`, and
   *   only to the DESKTOP client channel. Asking the global host with the CLI UA
   *   yields a truncated roster, and the CN path answers HTTP 500 there — which
   *   is what left the international provider on its static fallback.
   *
   * Both documents share the `{ models, agents }` entry shape, so the parsing
   * below is common to the two branches.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const global = regionOf(credential.domain) === 'global'
    const url = global
      ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}`
      : `${chatBase(credential)}${MODELS_CATALOG_PATH}`

    const headers: Record<string, string> = global
      ? {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': DESKTOP_UA,
        }
      : {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': CLIENT_UA,
        }
    if (!global && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
    }

    const response = await this.fetchImpl(url, {
      headers,
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

  /**
   * Report one chat-activity event to the growth system.
   *
   * The body is an ARRAY holding a single `chat_request_send` event, and every
   * field is filled in: a three-field minimal event is accepted with 200 and
   * then silently dropped, so the full shape is load-bearing rather than
   * cosmetic. `userId` is the one field the server actually keys on — without
   * it the request still answers 200 and scores nothing.
   *
   * One report per account per day is the quota the reference panel settled on;
   * a single report lights the growth streak and unlocks the `first_buddy`
   * family, which is why this runs before the task-centre pass.
   */
  async reportActivity(credential: WorkBuddyCredential, conversationId?: string): Promise<void> {
    const conversationID = conversationId ?? `wb2api-${Date.now()}`
    const requestID = conversationID
    const now = Date.now()
    const event = {
      eventCode: 'chat_request_send',
      timestamp: now,
      reportDelay: 0,
      mode: 'craft',
      conversationId: conversationID,
      requestId: requestID,
      inputLength: 12,
      requestModelId: 'deepseek-v4-flash',
      requestModelName: 'DeepSeek V4 Flash',
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [] as unknown[],
      knowledgeId: [] as unknown[],
      knowledgeName: [] as unknown[],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      expertId: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      fileUri: '',
      presentAt: now,
      traceId: '',
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'default',
      agentType: 'conversation',
      userId: credential.uid ?? '',
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Read back the growth streak in days.
   *
   * This is the read-only oracle for {@link reportActivity}: a report that
   * returned 200 yet left the streak untouched was silently dropped (a missing
   * `userId` is the usual cause), so callers verify instead of trusting the
   * status code.
   *
   * Two shape traps, both measured against the live upstream:
   *
   * - The path carries NO `/v2` prefix, unlike its sibling task endpoints under
   *   `/v2/activity/growth/*`. Asking for the `/v2` form does not 404; it
   *   answers with a body that carries no `streak` object at all.
   * - The counter is nested as `data.streak.days`, not `data.days`. Reading the
   *   flat field yields a constant 0, which would make every successful report
   *   look like a silent drop.
   *
   * Returns 0 only when the field is genuinely absent.
   */
  async growthStreakDays(credential: WorkBuddyCredential): Promise<number> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/streak`, {
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const streak = typeof data['streak'] === 'object' && data['streak'] !== null
      ? data['streak'] as Record<string, unknown>
      : {}
    return typeof streak['days'] === 'number' ? streak['days'] as number : 0
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

  /**
   * Fetch the growth task list for one account.
   *
   * The upstream answers `data.tasks[]`, and `claimable` is derived locally —
   * the upstream does not mark it. Only a task whose progress reached its
   * target and that is not already claimed counts as eligible.
   */
  async listTasks(credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
      headers: chatHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = Array.isArray(data['tasks']) ? data['tasks'] : []
    const out: WorkBuddyTask[] = []
    for (const entry of raw) {
      const parsed = parseTask(entry)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  /**
   * Accept (enrol in) tasks by code.
   *
   * Accepting is the "sign up" half: it produces no progress by itself, and the
   * upstream answers success for an already-accepted task, so replaying this is
   * safe. Progress is lit by real activity (a chat, an activity report).
   */
  async acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void> {
    if (taskCodes.length === 0) return
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
      method: 'POST',
      headers: chatHeaders(credential),
      body: JSON.stringify({ task_codes: [...taskCodes] }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Claim one task's reward.
   *
   * Two details differ from list/accept and are load-bearing:
   *
   * - The task code rides the PATH, not the body.
   * - It is served by the web origin, not the chat host, and only when the
   *   request carries the growth-centre Origin/Referer plus
   *   `x-client-platform: web`. The chat host's `/reward/claim` path does not
   *   exist and answers 400 "task not completed".
   *
   * A repeat claim answers `already_claimed` with zero credit, which is treated
   * as success so the caller can stay idempotent.
   */
  async claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<{ credit: number; energy: number }> {
    const headers: Record<string, string> = {
      ...billingHeaders(credential),
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.workbuddy.cn',
      'Referer': 'https://www.workbuddy.cn/profile/growth-center',
      'x-client-platform': 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    }
    const response = await this.fetchImpl(
      `https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
      { method: 'POST', headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) },
    )
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    if (data['already_claimed'] === true) return { credit: 0, energy: 0 }
    const credit = typeof data['credit'] === 'number' ? data['credit'] : 0
    const energy = typeof data['energy'] === 'number' ? data['energy'] : 0
    return { credit, energy }
  }
}
