/**
 * Account pool: discovers every WorkBuddy credential snapshot the desktop app
 * has left on this machine and hands out one healthy account per request,
 * rotating away from any account the upstream has rate-limited.
 *
 * Discovery is read-only: the desktop app's files are never written. Each
 * account is keyed by its billing identity (`uin`, falling back to `uid`), so
 * re-logging the same account refreshes in place instead of creating a duplicate.
 *
 * @module dsh-workbuddy-xdpool/accounts
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { regionOf, type WorkBuddyRegion } from './upstream.ts'
import {
  isEncryptedFieldWrapper,
  openEncryptedField,
  readAtRestKey,
} from './at-rest.ts'

/** Minimal upstream surface the pool needs to refresh a token (no circular import). */
export interface TokenRefresher {
  refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string
    refreshToken?: string
    expiresInSec?: number
    domain?: string
  }>
}

/** Live auth file name the WorkBuddy desktop app writes. */
export const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** Snapshot files left behind by previous logins share this prefix. */

/** Env override for the auth file or its directory. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** One parsed WorkBuddy credential. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  /**
   * When the upstream says it issued this token (`auth.lastRefreshTime`).
   *
   * This, not `expiresAtMs`, is the reliable freshness signal: the upstream
   * never rewrites a stored expiry when it revokes a token, so a long-dead
   * backup can claim to expire later than the token that actually works.
   * Absent on documents the desktop app did not write (the plugin's own
   * refreshed copy, older builds).
   */
  lastRefreshAtMs?: number
  nickname?: string
  uin?: string
  uid?: string
  enterpriseId?: string
  domain: string
  /** Where this credential came from, for diagnostics. */
  sourcePath: string
}

/** An account is a credential plus pool bookkeeping. */
export interface WorkBuddyAccount {
  /** Stable pool key: sha256 of the billing identity. */
  id: string
  /** Short human label, e.g. `青楫渡` or `青楫渡#29890334`. */
  label: string
  credential: WorkBuddyCredential
  /**
   * Epoch ms until which this account is skipped for EVERY model. Only set by
   * account-wide cooldowns (callers that penalize without a model id). The
   * upstream rate limit is actually per-model ("可切换其他模型继续使用"), so
   * routine 429s are tracked in {@link modelCooldowns} instead and never ban a
   * whole account.
   */
  cooldownUntilMs: number
  /**
   * Per-model cooldowns, keyed by upstream model id → epoch ms until that model
   * on THIS account is skipped. A 429 on `hy4-preview` cools only that model
   * here; `hy3`/`glm-*` on the same account keep serving.
   */
  modelCooldowns: Record<string, number>
  /** Consecutive rate-limit hits, for diagnostics. */
  rateLimitHits: number
}

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Platform-default directories holding the desktop app's auth files.
 * Windows probes Local before Roaming; a redirected profile still resolves
 * through the env location.
 */
export function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one string-valued field that may arrive as a plain string (older builds)
 * or as the desktop app's `$wbEncrypted` envelope. The app started encrypting
 * `accessToken` / `refreshToken` / `nickname` in 5.6.0 on BOTH macOS and Windows
 * — the earlier "Windows first" reading was wrong, and it is why a signed-in Mac
 * showed no account at all: the value is an object, `typeof === 'string'` failed,
 * and the parser reported "no credential" for a perfectly good sign-in.
 *
 * `decrypt` is injected rather than called here so this parser stays synchronous
 * and testable; the async key fetch lives in `readCredential`. A field that IS
 * encrypted but could not be opened is reported as `failed` rather than as an
 * empty string — the caller must tell the user the app is missing or unreachable,
 * not send them to sign in again (the one action that cannot help).
 */
/**
 * Marker for "the credential is encrypted and we could not obtain the key".
 *
 * Carried as a `code` rather than left to `instanceof` because the value crosses
 * the packaged-plugin boundary; the same convention the sibling error types use.
 * This is deliberately NOT "not signed in": the user IS signed in, and telling
 * them to sign in again sends them to the one action that cannot help.
 */
export const ENCRYPTED_CREDENTIAL_CODE = 'ENCRYPTED_CREDENTIAL'

export class WorkBuddyEncryptedCredentialError extends Error {
  readonly code = ENCRYPTED_CREDENTIAL_CODE
  constructor(sourcePath: string) {
    super(
      `workbuddy: ${sourcePath} holds encrypted credentials but the desktop app could not provide the key. `
        + 'Install the WorkBuddy desktop app (or point WORKBUDDY_APP_EXECUTABLE at it) — signing in again will not help.',
    )
    this.name = 'WorkBuddyEncryptedCredentialError'
  }
}

/** True when a thrown value is the encrypted-credential marker (cross-bundle safe). */
export function isEncryptedCredentialError(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { code?: unknown }).code === ENCRYPTED_CREDENTIAL_CODE
}

function decryptableString(
  value: unknown,
  decrypt: ((field: unknown) => string) | undefined,
): { value: string; encrypted: boolean; failed: boolean } {
  if (typeof value === 'string') return { value, encrypted: false, failed: false }
  if (isEncryptedFieldWrapper(value)) {
    if (decrypt === undefined) return { value: '', encrypted: true, failed: true }
    try {
      return { value: decrypt(value), encrypted: true, failed: false }
    } catch {
      return { value: '', encrypted: true, failed: true }
    }
  }
  return { value: '', encrypted: false, failed: false }
}

/**
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 *
 * `decrypt` opens the desktop app's `$wbEncrypted` field wrapper (5.6.0+, both
 * platforms). Absent means "plain-string builds only", which is what every
 * caller without an at-rest key should pass.
 */
export function parseWorkBuddyAuth(
  text: string,
  sourcePath: string,
  decrypt?: (field: unknown) => string,
): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>

  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity =
      typeof document['account'] === 'object' && document['account'] !== null
        ? (document['account'] as Record<string, unknown>)
        : {}
  } else {
    auth = document
    identity = document
  }

  const accessField = decryptableString(auth['accessToken'], decrypt)
  // An encrypted-but-unopenable credential must NOT be reported as a readable
  // one with an empty token: the caller has to distinguish "not signed in" from
  // "signed in, but the app holding the key is missing".
  if (accessField.encrypted && accessField.failed) {
    throw new WorkBuddyEncryptedCredentialError(sourcePath)
  }
  const accessToken = accessField.value
  if (accessToken === '') return undefined

  // Skip documents whose refresh window has already closed: they cannot recover.
  const refreshExpiresAtMs =
    typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  if (refreshExpiresAtMs !== undefined && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) {
    return undefined
  }

  // The upstream's own issue time, the only signal that stays truthful after a
  // token is revoked: credential selection prefers it over the stored expiry,
  // which a dead backup can claim arbitrarily far into the future.
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number'
    ? expiryToMs(auth['lastRefreshTime'])
    : undefined

  return {
    accessToken,
    refreshToken: decryptableString(auth['refreshToken'], decrypt).value,
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    ...optionalString(decryptableString(identity['nickname'], decrypt).value) === undefined
      ? {}
      : { nickname: optionalString(decryptableString(identity['nickname'], decrypt).value) },
    ...optionalString(identity['uin']) === undefined ? {} : { uin: optionalString(identity['uin']) },
    ...optionalString(identity['uid']) === undefined ? {} : { uid: optionalString(identity['uid']) },
    ...optionalString(identity['enterpriseId']) === undefined
      ? {}
      : { enterpriseId: optionalString(identity['enterpriseId']) },
    domain: typeof auth['domain'] === 'string' ? auth['domain'] : '',
    sourcePath,
  }
}

/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives re-login; `uid` is the fallback.
 */
/**
 * True when `path` is the desktop app's live sign-in (as opposed to a backup
 * snapshot it left behind). The live file always wins: it is the session the
 * app itself is using.
 */
function isLiveAuthFile(path: string): boolean {
  return basename(path) === WORKBUDDY_LIVE_FILENAME
}

/**
 * Which of two credentials for the same account the pool should keep.
 *
 * Ordering, highest first:
 *
 * 1. the live file the desktop app is signed in with;
 * 2. the credential the upstream issued most recently (`lastRefreshAtMs`);
 * 3. the longer stored expiry, as a fallback for documents that carry no issue
 *    time (the plugin's own refreshed copy, older builds).
 *
 * The stored expiry alone is NOT a freshness signal: the upstream does not
 * rewrite it when it revokes a token, so a long-dead backup can claim to expire
 * later than the token that actually works. Selecting on it made every upstream
 * call return 401 while a perfectly good credential sat in the same directory.
 */
function compareFreshness(a: WorkBuddyCredential, b: WorkBuddyCredential): number {
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0
  if (aLive !== bLive) return bLive - aLive

  const aIssued = a.lastRefreshAtMs ?? 0
  const bIssued = b.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued) return bIssued - aIssued

  return b.expiresAtMs - a.expiresAtMs
}

/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
  return compareFreshness(candidate, incumbent) < 0
}

export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>,
): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 16)
}

/** Human label; distinguishes same-nickname accounts by uid prefix. */
function accountLabel(credential: WorkBuddyCredential): string {
  const name = credential.nickname ?? 'WorkBuddy'
  const discriminator = (credential.uid ?? credential.uin ?? '').slice(0, 8)
  return discriminator === '' ? name : `${name}#${discriminator}`
}

/** List the auth files in one directory: the live file plus every snapshot. */
/**
 * Credential files in one auth directory, freshest first.
 *
 * Every `*.info` file counts, not just the timestamped `workbuddy-desktop.*`
 * snapshots: the international client signs in as `workbuddy-desktop-ai.info`
 * (a hyphen, not a dot), so a prefix test silently dropped every global
 * credential and the global provider then saw an empty pool.
 *
 * Filenames are plain strings, and the ordering here is only a first pass —
 * `isFresher` makes the real call once each file has been parsed.
 */
async function authFilesIn(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const files = entries.filter(name => name.endsWith('.info'))
  // Newest snapshot first so the freshest token wins when uids collide.
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  return files.map(name => join(dir, name))
}

async function readCredential(path: string): Promise<WorkBuddyCredential | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  // Fetch the app's at-rest key once per process, and only when the document
  // actually carries an encrypted field: plain-string builds must not spawn the
  // app at all. A missing key leaves `decrypt` undefined, which turns an
  // encrypted field into a thrown `WorkBuddyEncryptedCredentialError` instead of
  // a silent "no credential".
  const decrypt = text.includes('"$wbEncrypted"') ? await encryptedFieldOpener() : undefined
  try {
    return parseWorkBuddyAuth(text, path, decrypt)
  } catch (error: unknown) {
    if (isEncryptedCredentialError(error)) throw error
    return undefined
  }
}

/**
 * Build the field opener, or undefined when the app cannot supply its key.
 *
 * Split out so the key lookup is testable without a real desktop install, and so
 * a lookup failure degrades to "encrypted, unopenable" rather than to a parse
 * error that would look like a corrupt file.
 */
async function encryptedFieldOpener(): Promise<((field: unknown) => string) | undefined> {
  const key = await readAtRestKey().catch(() => undefined)
  if (key === undefined) return undefined
  return (field: unknown) => {
    if (!isEncryptedFieldWrapper(field)) throw new Error('workbuddy: not an encrypted field wrapper')
    return openEncryptedField(field, key)
  }
}

/** Every directory the pool should scan, in probe order. */
export function candidateAuthDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV])
  if (override !== undefined) {
    // The env var may name the file or its directory; accept both.
    dirs.push(override.toLowerCase().endsWith('.info') ? resolve(override, '..') : override)
  }
  dirs.push(...defaultDesktopAuthDirs(process.env['DSH_TEST_PLATFORM'] as NodeJS.Platform | undefined))
  return dirs
}

/** How the pool chooses which account serves the next request. */
export type AccountDistribution = 'priority' | 'round-robin' | 'balanced'

export interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[]
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number
  /** How long an account rests after its credits run out (default 30 minutes). */
  exhaustCooldownMs?: number
  /** Upstream client used to refresh near-expiry tokens. */
  client?: TokenRefresher
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /**
   * How requests are spread across the pool.
   *
   * - `priority` (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one
   *   account at a time, and a cooled account resumes at the head of the
   *   queue the moment its window resets.
   * - `round-robin`: consecutive requests rotate through the pool so the
   *   spend spreads evenly.
   */
  distribution?: AccountDistribution
}

/**
 * Read-only pool of every discovered WorkBuddy account, with rate-limit
 * cooldown and round-robin failover.
 */
/** Idle bonus per hour an account has been unused (reference-panel default). */
const IDLE_WEIGHT_PER_HOUR = 0.5
/** Ceiling for the idle bonus, so an idle account cannot dominate forever. */
const IDLE_WEIGHT_MAX = 5

/**
 * Weight one account by how long it has been idle.
 *
 * The base of 1 keeps every eligible account in play: an account that served a
 * moment ago still has a small chance, so a single unhealthy account cannot pin
 * the pool to itself, and the weights never sum to zero.
 *
 * `lastUsedAt === undefined` means "never used in this process", which earns the
 * full bonus: on a fresh start every account ties, and the weighted draw spreads
 * the first requests instead of always picking the first entry.
 */
function idleWeight(lastUsedAt: number | undefined, now: number): number {
  if (lastUsedAt === undefined) return 1 + IDLE_WEIGHT_MAX
  const hours = (now - lastUsedAt) / 3_600_000
  // A clock jump backwards would produce a negative idle term; clamp to 0.
  const idle = Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX)
  return 1 + idle
}

/** Default rest for an account whose credits ran out (packs reset on their own schedule). */
const EXHAUST_COOLDOWN_MS = 30 * 60 * 1000

export class WorkBuddyAccountPool {
  private readonly logger: AccountPoolOptions['logger']
  private authDirs: readonly string[]
  private cooldownMs: number
  /**
   * How long an account stays out of rotation after the upstream reports its
   * credits are spent. Credit packs reset on their own schedule rather than on a
   * rate-limit window, so this is much longer than `cooldownMs`.
   */
  private exhaustCooldownMs: number
  private readonly client: TokenRefresher | undefined
  private readonly refreshMarginMs: number
  private accounts: WorkBuddyAccount[] = []
  private distribution: AccountDistribution
  /** Cursor for round-robin mode; unused under priority distribution. */
  private cursor = 0
  private lastScanAtMs = 0
  private preferredId: string | undefined
  /**
   * Account ids the user switched off on the card.
   *
   * Disabling is a user preference rather than a property of the credential:
   * `scan()` rebuilds every account object from the auth files, so the set
   * lives on the pool and is re-applied from settings after each scan.
   */
  private disabledIds = new Set<string>()
  /**
   * Per-account credit floor, keyed by account id. 0 (or absent) means "spend
   * it all".
   *
   * A reserved balance is protection, not a hard limit the upstream knows
   * about: the pool simply stops picking that account once its last known
   * balance is at or below the floor, so the user keeps a cushion instead of
   * draining every account to zero.
   */
  private creditReserves = new Map<string, number>()
  /**
   * Last known credit balance per account, epoch ms aside.
   *
   * Refreshed in the background after a successful request, so a pick can
   * consult it. An account with no reading is treated as usable: refusing to
   * pick an account just because its balance has not been checked yet would
   * strand a healthy pool, and the first 402 still cools it as before.
   */
  private creditBalances = new Map<string, number>()
  /**
   * Last time each account served a request, epoch ms. Drives the idle term
   * of the priority-mode weighting below: an account that just served loses to
   * one that has been idle, so a small pool stops hammering a single account.
   *
   * In-memory on purpose: it only biases the next pick, so a cold start that
   * treats every account as idle is the right default. Not keyed by id lookup
   * misses because a removed account simply disappears from the map on re-scan.
   */
  private lastUsedAt = new Map<string, number>()
  private refreshInflight = new Map<string, Promise<void>>()

  constructor(options: AccountPoolOptions = {}) {
    this.logger = options.logger
    this.authDirs = options.authDirs ?? candidateAuthDirs()
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.exhaustCooldownMs = options.exhaustCooldownMs ?? EXHAUST_COOLDOWN_MS
    this.client = options.client
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    // Priority is the default: users pool their own accounts to spend one
    // before touching the next, not to split every request evenly.
    this.distribution = options.distribution ?? 'priority'
  }

  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options: {
    authDirs?: readonly string[]
    cooldownMs?: number
    exhaustCooldownMs?: number
    distribution?: AccountDistribution
    disabledAccountIds?: readonly string[]
    /** Per-account credit floor, keyed by account id. Absent keeps the current map. */
    creditReserves?: Readonly<Record<string, number>>
  }): void {
    if (options.authDirs !== undefined && options.authDirs.length > 0) {
      this.authDirs = options.authDirs
    }
    if (options.cooldownMs !== undefined && options.cooldownMs >= 1000) {
      this.cooldownMs = options.cooldownMs
    }
    if (options.exhaustCooldownMs !== undefined && options.exhaustCooldownMs >= 1000) {
      this.exhaustCooldownMs = options.exhaustCooldownMs
    }
    if (options.distribution !== undefined) {
      this.distribution = options.distribution
    }
    if (options.disabledAccountIds !== undefined) {
      this.disabledIds = new Set(options.disabledAccountIds)
    }
    // Reserves are replaced wholesale so the map mirrors the saved document.
    if (options.creditReserves !== undefined) this.setCreditReserves(options.creditReserves)
  }

  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan(): Promise<WorkBuddyAccount[]> {
    const found: WorkBuddyCredential[] = []
    for (const dir of this.authDirs) {
      for (const file of await authFilesIn(dir)) {
        const credential = await readCredential(file)
        if (credential !== undefined) found.push(credential)
      }
    }

    const byId = new Map<string, WorkBuddyAccount>()
    // Seed with existing accounts so cooldown state survives a rescan.
    for (const account of this.accounts) byId.set(account.id, account)

    for (const credential of found) {
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, {
          id,
          label: accountLabel(credential),
          credential,
          cooldownUntilMs: 0,
          modelCooldowns: {},
          rateLimitHits: 0,
        })
        continue
      }
      // Keep whichever credential the app/upstream considers current. The stored
      // expiry alone is not a freshness signal, so this goes through `isFresher`
      // rather than comparing expiry values directly.
      if (isFresher(credential, existing.credential)) {
        byId.set(id, { ...existing, credential, label: accountLabel(credential) })
      }
    }

    // A stable, predictable order is what makes "prefer the first account"
    // meaningful: a live sign-in leads, then the most recently issued
    // credential, then the newest expiry. `byId` already preserves the order
    // accounts were first discovered, so re-scans do not shuffle the queue.
    const ordered = [...byId.values()]
    ordered.sort((a, b) => compareFreshness(a.credential, b.credential))
    this.accounts = ordered
    this.lastScanAtMs = Date.now()
    return this.accounts
  }

  /** All accounts, cooldown state included. */
  list(region?: WorkBuddyRegion): readonly WorkBuddyAccount[] {
    if (region === undefined) return this.accounts
    return this.accounts.filter(account => regionOf(account.credential.domain) === region)
  }

  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics).
   */
  private available(now: number, modelId?: string, region?: WorkBuddyRegion): WorkBuddyAccount[] {
    return this.accounts.filter(account => {
      // Switched off on the card: never serves a request, but still listed so
      // the card can switch it back on.
      if (this.disabledIds.has(account.id)) return false
      // Reserved credits: stop picking an account once its last known balance
      // reached the floor the user set for it. An account with no reading stays
      // in play (see creditBalances), so an unprobed pool is not stranded.
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) {
        const balance = this.creditBalances.get(account.id)
        if (balance !== undefined && balance <= reserve) return false
      }
      if (account.cooldownUntilMs > now) return false
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false
      // A region-scoped caller (one of the two providers) must never pick
      // an account that talks to the other region gateway.
      if (region !== undefined && regionOf(account.credential.domain) !== region) return false
      return true
    })
  }

  /** Round-robin: the legacy cursor walk, kept for the distribution that asks for it. */
  private pickRoundRobin(pool: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    const index = this.cursor % pool.length
    const account = pool[index]
    if (account === undefined) return undefined
    this.cursor = (index + 1) % pool.length
    return account
  }

  /**
   * Priority mode: weighted random over the eligible accounts.
   *
   * The weight is an idle bonus — `1 + min(idleHours * perHour, max)` — so an
   * account that has never served (or has been idle for a while) outranks one
   * that just answered. Reference panel logic drops its success-rate term
   * entirely because a lifetime error counter penalises an account forever;
   * instantaneous health is already handled by cooldowns, which is why those
   * accounts never reach this list.
   *
   * A pool with no idle history (fresh process) hashes to equal weights, which
   * spreads the very first picks instead of always returning index 0.
   */
  private pickByWeight(pool: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    if (pool.length === 1) return pool[0]
    const now = Date.now()
    const weights = pool.map((account) => idleWeight(this.lastUsedAt.get(account.id), now))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (!Number.isFinite(total) || total <= 0) return pool[0]
    let roll = Math.random() * total
    for (let index = 0; index < pool.length; index += 1) {
      roll -= weights[index] ?? 0
      if (roll < 0) return pool[index]
    }
    return pool[pool.length - 1]
  }

  /**
   * Pick the account to serve a request.
   *
   * Two distributions, chosen by the `distribution` setting:
   *
   * - **priority** (default, and what the card ships with): one account serves
   *   every request until it is rate-limited, then the next in order takes over.
   *   Credits drain one account at a time, and a cooling account returns to the
   *   head of the queue the moment its window resets — it was never consumed, so
   *   it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   *
   * In both modes an explicit user selection (`prefer`) heads the list, a
   * cooling account is skipped for that model only, and an unrecognised setting
   * falls back to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   */
  async acquire(modelId?: string, region?: WorkBuddyRegion): Promise<WorkBuddyAccount | undefined> {
    if (this.accounts.length === 0) await this.scan()
    let pool = this.available(Date.now(), modelId, region)
    if (pool.length === 0) {
      await this.scan()
      pool = this.available(Date.now(), modelId, region)
    }
    if (pool.length === 0) return undefined

    // An explicit pick wins outright when it is eligible. Reordering the list
    // is not enough now that priority mode draws by weight: the user asked for
    // one account, so the draw should not be able to pick another.
    if (this.preferredId !== undefined) {
      const preferred = pool.find(account => account.id === this.preferredId)
      if (preferred !== undefined) {
        await this.ensureFresh(preferred)
        return preferred
      }
    }

    // `priority` keeps the original behaviour: the head of the ordered list
    // answers until it is limited, which is what a pool of your own accounts is
    // for. `round-robin` walks the cursor. `balanced` draws by weight so a quiet
    // pool spreads across accounts instead of draining the first one.
    const account = this.distribution === 'round-robin'
      ? this.pickRoundRobin(pool)
      : this.distribution === 'balanced'
        ? this.pickByWeight(pool)
        : pool[0]
    // Serving is recorded by noteServed once the upstream answers 200, not
    // here: picking only says which account is being tried, and the shim may
    // still rotate before the request succeeds.
    if (account === undefined) return undefined
    await this.ensureFresh(account)
    return account
  }

  /** Pin the account the plugin card should prefer; tokens stay out of settings. */
  /** How the pool currently spreads requests. Shown on the card. */
  currentDistribution(): AccountDistribution {
    return this.distribution
  }

  prefer(accountId: string | undefined): void {
    this.preferredId = accountId
  }

  /** Whether the user switched this account off on the card. */
  isDisabled(accountId: string): boolean {
    return this.disabledIds.has(accountId)
  }

  /** Every account id the user switched off, in discovery order. */
  disabledIdsInOrder(): string[] {
    return this.accounts.filter(account => this.disabledIds.has(account.id)).map(account => account.id)
  }

  /**
   * Record that an account actually served a request.
   *
   * Called by the shim once the upstream answers 200 — only then is the account
   * the one the user is really being served by. `balanced` mode reads the same map
   * for its idle weighting, so a request that failed over to another account must
   * not count as used for the account that was merely tried.
   */
  noteServed(accountId: string): void {
    if (!this.accounts.some(account => account.id === accountId)) return
    this.lastUsedAt.set(accountId, Date.now())
  }

  /**
   * Record an account latest known credit balance.
   *
   * Called after a request and by the card balance refresh, so the reserve
   * check has something to compare against. A reading for an unknown account is
   * dropped: `scan()` rebuilds the account list and a stale id would otherwise
   * accumulate forever.
   */
  noteCredits(accountId: string, balance: number): void {
    if (!Number.isFinite(balance)) return
    if (!this.accounts.some(account => account.id === accountId)) return
    this.creditBalances.set(accountId, balance)
  }

  /** Last known balance for one account, or undefined when never read. */
  creditsOf(accountId: string): number | undefined {
    return this.creditBalances.get(accountId)
  }

  /** The credit floor the user set for one account; 0 when unset. */
  creditReserveOf(accountId: string): number {
    return this.creditReserves.get(accountId) ?? 0
  }

  /**
   * Replace every reserve. Called from settings on each apply, so the map
   * mirrors the saved document exactly instead of accumulating old keys.
   */
  setCreditReserves(reserves: Readonly<Record<string, number>>): void {
    const next = new Map<string, number>()
    for (const [id, value] of Object.entries(reserves)) {
      if (Number.isFinite(value) && value > 0) next.set(id, Math.floor(value))
    }
    this.creditReserves = next
  }

  /** Every reserve currently in force, keyed by account id. */
  creditReservesInOrder(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const account of this.accounts) {
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) out[account.id] = reserve
    }
    return out
  }

  /**
   * Whether an account is held back only by its reserve.
   *
   * Separates "resting to protect credits" from every other reason an account
   * is out of rotation, which is what the card shows the user.
   */
  isReserved(accountId: string): boolean {
    const reserve = this.creditReserves.get(accountId)
    if (reserve === undefined || reserve <= 0) return false
    const balance = this.creditBalances.get(accountId)
    return balance !== undefined && balance <= reserve
  }

  /**
   * The account that served the most recent request, if any.
   *
   * Distinct from "who would serve the next one": this is a record of what
   * actually happened, which is what the card needs to answer "which account am
   * I using right now?". Under `balanced` there is no deterministic next account
   * at all, so a recorded fact is the only honest answer.
   *
   * Returns undefined before the first request of the process, and after every
   * known account has been re-scanned away (a login swapped out under us).
   */
  lastServedId(): string | undefined {
    let newest: { id: string; at: number } | undefined
    for (const [id, at] of this.lastUsedAt) {
      if (!this.accounts.some(account => account.id === id)) continue
      if (newest === undefined || at > newest.at) newest = { id, at }
    }
    return newest?.id
  }

  /** Best-effort refresh of one account after a session-dead upstream answer. */
  async refreshAccount(accountId: string): Promise<void> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    await this.ensureFresh(account)
  }

  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   */
  private async ensureFresh(account: WorkBuddyAccount): Promise<void> {
    if (this.client === undefined) return
    const credential = account.credential
    const expiring = credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs
    if (!expiring) return
    const existing = this.refreshInflight.get(account.id)
    if (existing !== undefined) {
      await existing
      return
    }
    const run = (async () => {
      if (credential.refreshToken === '') {
        // Nothing to refresh with; only worth failing if already expired.
        if (credential.expiresAtMs > Date.now() + 30_000) return
        this.logger?.warn(`dsh-workbuddy-xdpool: ${account.label} token expired with no refresh token; sign in again`)
        return
      }
      try {
        const outcome = await this.client!.refreshToken(credential)
        account.credential = {
          ...credential,
          accessToken: outcome.accessToken,
          ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
          expiresAtMs: outcome.expiresInSec !== undefined
            ? Date.now() + outcome.expiresInSec * 1000
            : credential.expiresAtMs,
          ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        }
        this.logger?.info?.(`dsh-workbuddy-xdpool: refreshed token for ${account.label}`)
      } catch (error: unknown) {
        if (credential.expiresAtMs > Date.now() + 30_000) {
          this.logger?.warn?.(`dsh-workbuddy-xdpool: token refresh failed but token still valid for ${account.label}`, error)
        } else {
          this.logger?.error?.(`dsh-workbuddy-xdpool: token refresh failed and token expired for ${account.label}`, error)
        }
      }
    })()
    this.refreshInflight.set(account.id, run)
    try {
      await run
    } finally {
      this.refreshInflight.delete(account.id)
    }
  }

  /**
   * Cool a whole account after the upstream reports its credits are spent.
   *
   * Credit exhaustion is an ACCOUNT condition, unlike a model rate limit: every
   * model on that account is unusable until the quota resets, so this cools the
   * account as a whole (no `modelId`) for the configured exhaustion window. The
   * shim then rotates to a different account instead of failing the request.
   */
  penalizeExhausted(accountId: string): void {
    const until = Date.now() + this.exhaustCooldownMs
    this.penalize(accountId, until)
    this.logger?.warn(
      
`
dsh-workbuddy-xdpool: account credits exhausted; cooling the whole account until 
`
 +
        
`
${new Date(until).toISOString()}
`
,
    )
  }

  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   */
  penalize(accountId: string, resetAtMs?: number, modelId?: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.rateLimitHits += 1
    const until = resetAtMs ?? Date.now() + this.cooldownMs
    if (modelId !== undefined && modelId !== '') {
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until)
      this.logger?.warn(
        `dsh-workbuddy-xdpool: ${account.label} rate-limited on model ${modelId}; ` +
          `cooling that model until ${new Date(until).toISOString()}`,
      )
      return
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until)
    this.logger?.warn(
      `dsh-workbuddy-xdpool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`,
    )
  }

  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns(): void {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0
      account.modelCooldowns = {}
      account.rateLimitHits = 0
    }
  }

  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status(): { count: number; cooling: number; lastScanAtMs: number } {
    const now = Date.now()
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter(account => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs,
    }
  }
}
