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
  encryptedFieldKeyId,
  isEncryptedFieldWrapper,
  openEncryptedField,
  readAtRestKey,
  atRestKeyFor,
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
/**
 * A credential file the pool could not turn into an account.
 *
 * Reported (not swallowed) because the count is otherwise a lie: a directory
 * holding four files that yields two accounts looks like two accounts were
 * deleted, when in fact two files were unreadable. Naming the file and the
 * reason is what makes the difference visible.
 */
export interface WorkBuddySkippedFile {
  path: string
  reason: 'encrypted' | 'unreadable' | 'malformed'
}

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
  /**
   * Epoch ms until which this account is skipped because the upstream REJECTED
   * its sign-in (401/403), not because of a rate limit.
   *
   * A revoked session is invisible from the credential file: the upstream does
   * not rewrite `expiresAtMs` when it kills a refresh token, so a dead account
   * looks perfectly fresh and, without this field, gets picked again on the very
   * next attempt. With `maxAttempts` retries that meant one dead account could
   * absorb an entire request while healthy accounts were never tried.
   *
   * Only a fresh sign-in in the desktop app clears it, so the cooldown is long;
   * `0`/undefined means "not known to be dead".
   */
  credentialDeadUntilMs?: number
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
      `workbuddy: ${sourcePath} holds encrypted credentials, but no WorkBuddy desktop app could be located to provide the key.`
        + ' If the app IS installed, it is simply outside the paths this plugin probes — set '
        + 'WORKBUDDY_APP_EXECUTABLE to its full .exe path (then restart DSH) and the credential will open.'
        + ' Signing in again will not help: the credential itself is intact. '
        + 'Run `dsh-workbuddy-xdpool doctor` to see which paths were probed — if one of them looks like '
        + 'mojibake (e.g. "??" where a Chinese folder name should be), the registry value could not be '
        + 'decoded on this machine; report that line and use the override above in the meantime.',
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

/**
 * One credential file, or undefined when it cannot be used.
 *
 * Returns undefined — rather than throwing — for every failure mode, so ONE bad
 * file cannot empty the pool. That is the whole point: an auth directory blends
 * plain files, encrypted files, half-written files and files from an app version
 * this plugin cannot read, and a scan that aborts on the first unusable one
 * reports "you have 2 accounts" when it means "I could not open the other two".
 *
 * The caller surfaces the ones it skipped, so the count never silently
 * disagrees with what is on disk.
 */
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
  } catch {
    // Encrypted-but-unopenable, malformed, or an unknown shape: skip THIS file.
    // Previously this rethrew `WorkBuddyEncryptedCredentialError`, which
    // propagated out of `scan()` and discarded every account that had parsed
    // fine — the reported "4 accounts become 2 after switching sign-in".
    return undefined
  }
}

/**
 * The pool id a document would receive, WITHOUT decrypting anything.
 *
 * Used to honour the ignore list before the at-rest key lookup runs: `uin` and
 * `uid` are read as plain strings by {@link parseWorkBuddyAuth}, while
 * `nickname` is commonly encrypted — so this returns undefined for an account
 * whose identity lives only in the encrypted nickname, and the caller falls
 * back to the full parse for those.
 */
export function cheapIdentityId(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const identity =
    typeof document['account'] === 'object' && document['account'] !== null
      ? (document['account'] as Record<string, unknown>)
      : document
  const uin = typeof identity['uin'] === 'string' && identity['uin'] !== '' ? identity['uin'] : undefined
  const uid = typeof identity['uid'] === 'string' && identity['uid'] !== '' ? identity['uid'] : undefined
  if (uin === undefined && uid === undefined) return undefined
  // `workbuddyAccountId` reads `uin` first, exactly as the full parse does, so
  // this cheap id agrees with the id the account would really be filed under.
  return workbuddyAccountId({ ...uin === undefined ? {} : { uin }, ...uid === undefined ? {} : { uid } })
}

/** {@link cheapIdentityId} for a file path; undefined when it cannot be read. */
async function cheapIdentityIdFromFile(path: string): Promise<string | undefined> {
  try {
    return cheapIdentityId(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Why a file could not become an account.
 *
 * Distinguishing "encrypted" matters most: it is actionable (start the desktop
 * app, or set the executable override), whereas "malformed" means the file is
 * simply not a credential. Reporting them alike would send the user looking for
 * a fix that cannot work.
 */
async function skipReasonFor(path: string): Promise<WorkBuddySkippedFile['reason']> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return 'unreadable'
  }
  if (text.includes('"$wbEncrypted"')) return 'encrypted'
  try {
    JSON.parse(text)
    return 'malformed'
  } catch {
    return 'malformed'
  }
}

/**
 * Build the field opener, or undefined when the app cannot supply its key.
 *
 * Split out so the key lookup is testable without a real desktop install, and so
 * a lookup failure degrades to "encrypted, unopenable" rather than to a parse
 * error that would look like a corrupt file.
 */
export async function encryptedFieldOpener(): Promise<((field: unknown) => string) | undefined> {
  // Warm the per-key-id cache so the synchronous closure below can resolve each
  // field's own key. Each encrypted field names the key id it was sealed under
  // (WorkBuddyEncryptedField.envelope.keyId); when more than one desktop build
  // (domestic and international) is installed on one machine, every build yields
  // its key here and the field selects its own. A build that fails to answer is
  // skipped on its own (mirroring the reference provideTheKey), so one bad spawn
  // cannot hide the others behind a process-wide undefined key.
  await readAtRestKey().catch(() => undefined)
  return (field: unknown) => {
    if (!isEncryptedFieldWrapper(field)) throw new Error('workbuddy: not an encrypted field wrapper')
    const keyId = encryptedFieldKeyId(field)
    if (keyId === undefined) throw new Error('workbuddy: encrypted field has no key id')
    const key = atRestKeyFor(keyId)
    if (key === undefined) throw new Error('workbuddy: no at-rest key available for this encrypted field')
    return openEncryptedField(field, key)
  }
}

// Warm the key cache for any installed build before the first parse, so a field
// resolves synchronously inside the opener above. Exposed for tests/diagnostics.
export async function primeAtRestKeys(): Promise<void> {
  await readAtRestKey().catch(() => undefined)
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
export type AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'

/**
 * How many conversation→account bindings `sticky` mode remembers.
 *
 * Only a memory bound: evicting the oldest binding costs one re-pick on that
 * conversation's next turn, it never loses an account or a request.
 */
const STICKY_AFFINITY_LIMIT = 200

export interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[]
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number
  /** How long an account rests after its credits run out (default 30 minutes). */
  exhaustCooldownMs?: number
  /**
   * How long an account rests after the upstream rejects its sign-in
   * (default 30 minutes). Only a fresh sign-in in the desktop app clears it.
   */
  credentialDeadCooldownMs?: number
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
   * - `sticky`: one account per conversation, and a new conversation moves to
   *   the next account in order. Keeps the upstream prompt cache warm inside a
   *   conversation while still spreading spend across conversations.
   * - `expiry`: the account whose one-off credit packs expire soonest serves
   *   first, so use-it-or-lose-it credits are spent before they die. Accounts
   *   with no known expiry sort last, so a pool that has never been probed
   *   behaves like `priority`.
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

/**
 * Default rest for an account the upstream rejected the sign-in of (401/403).
 *
 * Unlike a rate limit there is no reset time to read: only signing in again in
 * the desktop app revives the account. The rest is therefore long enough that a
 * single request never burns its whole retry budget on the same dead credential,
 * but short enough that a user who just signed in is not locked out of their own
 * account for long — and a newer credential file clears the mark outright.
 */
const CREDENTIAL_DEAD_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Does this refresh failure prove the credential itself is dead?
 *
 * The upstream answers a revoked refresh token with `invalid_grant: Offline user
 * session not found` (HTTP 400/401). Network failures, DNS errors and 5xx do NOT
 * prove anything about the credential and must not mark it dead — that would
 * take a working account out of rotation for half an hour over a hiccup.
 */
function isCredentialDeadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('invalid_grant')
    || message.includes('Offline user session not found')
    || message.includes('session_dead')
}

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
  /**
   * How long an account stays out of rotation after the upstream rejected its
   * sign-in. Cleared by a newer credential file or an explicit sign-in.
   */
  private credentialDeadCooldownMs: number
  private readonly client: TokenRefresher | undefined
  private readonly refreshMarginMs: number
  private accounts: WorkBuddyAccount[] = []
  /**
   * Files the last scan could not read, with the reason.
   *
   * Surfaced so "2 accounts" can be told apart from "4 files, 2 unreadable" —
   * the difference between accounts being gone and files being unopenable.
   */
  private skippedFiles: WorkBuddySkippedFile[] = []
  private distribution: AccountDistribution
  /** Cursor for round-robin mode; unused under priority distribution. */
  private cursor = 0
  /**
   * `sticky` mode: conversation key → account id.
   *
   * A conversation that keeps the same account also keeps that account's
   * upstream prompt cache warm — the cache is per tenant, so rotating accounts
   * mid-conversation pays full prompt cost on every turn. Insertion order is
   * the LRU order: re-binding deletes then re-inserts.
   */
  private readonly affinity = new Map<string, string>()
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
   * Account ids the user threw out of the pool for good.
   *
   * Enforced BEFORE the credential is parsed: `scan()` skips a file whose
   * identity is already ignored, so an ignored account costs no at-rest key
   * lookup (which spawns the desktop app on 5.6.0+) and cannot re-enter the pool
   * when the app writes a fresh sign-in for it. That is the difference from
   * {@link disabledIds}, which only filters at pick time and leaves the account
   * listed, readable and re-discoverable.
   *
   * The set is supplied by the host from the plugin's own ignore file, and is
   * replaced wholesale on every {@link applyIgnored} so removing an entry takes
   * effect on the next scan without a restart.
   */
  private ignoredIds = new Set<string>()
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
   * Nearest expiry among each account's one-off credit packs, epoch ms.
   *
   * Credit packs are use-it-or-lose-it, so "which account should serve next"
   * has a second honest answer besides "which one is idle": the one whose
   * credits die soonest. Only one-off packs count — monthly packs refresh on
   * their own cycle and are therefore never urgent — which is why this is
   * written from the same `fetchCredits` reading that fills `creditBalances`.
   *
   * An absent entry means "never probed, or nothing is about to expire". Both
   * are the same thing to `expiry` mode: not urgent, so it sorts last.
   */
  private creditExpiry = new Map<string, number>()
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
  private refreshInflight = new Map<string, Promise<boolean>>()

  constructor(options: AccountPoolOptions = {}) {
    this.logger = options.logger
    this.authDirs = options.authDirs ?? candidateAuthDirs()
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.exhaustCooldownMs = options.exhaustCooldownMs ?? EXHAUST_COOLDOWN_MS
    this.credentialDeadCooldownMs = options.credentialDeadCooldownMs ?? CREDENTIAL_DEAD_COOLDOWN_MS
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

  /**
   * Replace the permanent ignore list.
   *
   * Also drops any already-discovered account that is now ignored, so the change
   * is visible without waiting for the next scan: the card refreshes its status
   * document right after the write, and an account still sitting in `accounts`
   * would keep showing up there.
   */
  applyIgnored(ids: Iterable<string>): void {
    this.ignoredIds = new Set(ids)
    if (this.ignoredIds.size === 0) return
    this.accounts = this.accounts.filter(account => !this.ignoredIds.has(account.id))
  }

  /** Whether this account has been thrown out of the pool for good. */
  isIgnored(accountId: string): boolean {
    return this.ignoredIds.has(accountId)
  }

  /** Every ignored id currently in force, in insertion order. */
  ignoredIdsInOrder(): string[] {
    return [...this.ignoredIds]
  }

  /**
   * Credential files the last scan could not read, with the reason.
   *
   * Exposed because a short account list is otherwise indistinguishable from a
   * broken one: with this, the card can say "2 accounts, 2 files unreadable"
   * instead of silently showing half a pool.
   */
  skippedFilesInOrder(): readonly WorkBuddySkippedFile[] {
    return this.skippedFiles
  }

  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan(): Promise<WorkBuddyAccount[]> {
    const found: WorkBuddyCredential[] = []
    const skipped: WorkBuddySkippedFile[] = []
    for (const dir of this.authDirs) {
      for (const file of await authFilesIn(dir)) {
        // Honour the ignore list BEFORE reading the document's key material.
        // `cheapIdentityId` reads only the plain `uin`/`uid` fields, so an
        // ignored account is skipped without spawning the desktop app for its
        // at-rest key. A document whose identity lives in an encrypted nickname
        // returns undefined here and is checked again after the full parse
        // below — slower, but never wrongly admitted.
        if (this.ignoredIds.size > 0) {
          const cheapId = await cheapIdentityIdFromFile(file)
          if (cheapId !== undefined && this.ignoredIds.has(cheapId)) continue
        }
        const credential = await readCredential(file)
        if (credential === undefined) {
          // Record WHY, so a pool of "2" next to a disk holding 4 files can say
          // which two were unreadable and what prevented them. Silently dropping
          // them is what made the number look like accounts had vanished.
          skipped.push({ path: file, reason: await skipReasonFor(file) })
          continue
        }
        // Second gate: the cheap probe could not identify this file, so the
        // ignored check happens now that the credential is fully parsed.
        if (this.ignoredIds.size > 0 && this.ignoredIds.has(workbuddyAccountId(credential))) continue
        found.push(credential)
      }
    }
    this.skippedFiles = skipped
    if (skipped.length > 0) {
      this.logger?.warn?.(
        `dsh-workbuddy-xdpool: ${skipped.length} credential file(s) could not be read; `
        + `${found.length} account(s) still loaded. Reasons: `
        + [...new Set(skipped.map(s => s.reason))].join('; '),
      )
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
        // A different refresh token means the user signed in again, which is the
        // one thing that revives an account the upstream had rejected. Without
        // this the dead mark would outlive the very fix it is waiting for.
        const signedInAgain = credential.refreshToken !== existing.credential.refreshToken
          || credential.accessToken !== existing.credential.accessToken
        byId.set(id, {
          ...existing,
          credential,
          label: accountLabel(credential),
          ...signedInAgain ? { credentialDeadUntilMs: 0 } : {},
        })
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
      // Sign-in rejected by the upstream: the credential file still LOOKS fresh
      // (the upstream never rewrites its expiry), so this is the only thing
      // keeping a dead account from absorbing every retry of a request.
      if ((account.credentialDeadUntilMs ?? 0) > now) return false
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false
      // A region-scoped caller (one of the two providers) must never pick
      // an account that talks to the other region gateway.
      if (region !== undefined && regionOf(account.credential.domain) !== region) return false
      return true
    })
  }

  /**
   * Why no account is available right now, for an accurate error.
   *
   * The pool can be empty for reasons that need OPPOSITE remedies: nobody is
   * signed in (the user must sign in), every account is rate-limited (the user
   * must wait, and retrying later works), or every account was switched off /
   * ignored (the user must re-enable one). Reporting all of them as "no
   * credential, sign in" sent users to re-authenticate over a temporary 429 —
   * observed as an "API key invalid" panel for a model that was merely cooling.
   *
   * Counts are over the region's accounts, since a provider only ever sees its
   * own gateway.
   */
  unavailableReason(modelId?: string, region?: WorkBuddyRegion): {
    total: number
    cooling: number
    disabled: number
    /** Accounts skipped because the upstream rejected their sign-in. */
    dead: number
    reason: 'empty' | 'cooling' | 'disabled' | 'reserve' | 'session_dead' | 'none'
  } {
    const now = Date.now()
    const inRegion = this.accounts.filter(
      account => region === undefined || regionOf(account.credential.domain) === region,
    )
    if (inRegion.length === 0) return { total: 0, cooling: 0, disabled: 0, dead: 0, reason: 'empty' }

    let cooling = 0
    let disabled = 0
    let dead = 0
    for (const account of inRegion) {
      if (this.disabledIds.has(account.id)) { disabled += 1; continue }
      // Sign-in rejected: counted separately from "cooling", because the remedy
      // is the opposite one (sign in again, not wait).
      if ((account.credentialDeadUntilMs ?? 0) > now) { dead += 1; continue }
      const modelCooling = modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now
      if (account.cooldownUntilMs > now || modelCooling) { cooling += 1; continue }
      const reserve = this.creditReserves.get(account.id)
      if (reserve !== undefined && reserve > 0) {
        const balance = this.creditBalances.get(account.id)
        if (balance !== undefined && balance <= reserve) {
          return { total: inRegion.length, cooling, disabled, dead, reason: 'reserve' }
        }
      }
    }
    // A rejected sign-in outranks a cooldown: waiting does not fix it.
    if (dead > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'session_dead' }
    if (cooling > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'cooling' }
    if (disabled > 0) return { total: inRegion.length, cooling, disabled, dead, reason: 'disabled' }
    return { total: inRegion.length, cooling, disabled, dead, reason: 'none' }
  }

  /** Round-robin: the legacy cursor walk, kept for the distribution that asks for it. */
  private pickRoundRobin(pool: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    const index = this.cursor % pool.length
    const account = pool[index]
    if (account === undefined) return undefined
    this.cursor = (index + 1) % pool.length
    return account
  }

  /** Remember which account a conversation is bound to, keeping LRU order. */
  private bindAffinity(conversationKey: string, accountId: string): void {
    this.affinity.delete(conversationKey)
    this.affinity.set(conversationKey, accountId)
    while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
      const oldest = this.affinity.keys().next().value
      if (oldest === undefined) break
      this.affinity.delete(oldest)
    }
  }

  /**
   * `sticky`: the account this conversation already used, when it can still
   * serve the model being asked for.
   *
   * Returns `undefined` both when there is no binding and when the binding is
   * no longer eligible (cooling for this model, disabled, out of credits) — the
   * caller then rebinds, which is what makes a rate-limited conversation hop to
   * a fresh account instead of failing.
   */
  private affinityAccount(pool: readonly WorkBuddyAccount[], conversationKey: string | undefined): WorkBuddyAccount | undefined {
    if (conversationKey === undefined || conversationKey === '') return undefined
    const boundId = this.affinity.get(conversationKey)
    if (boundId === undefined) return undefined
    const bound = pool.find(account => account.id === boundId)
    if (bound === undefined) {
      // The binding is stale: the account is gone, disabled, or cooling for
      // this model. Drop it so the next turn does not re-check it.
      this.affinity.delete(conversationKey)
      return undefined
    }
    // Re-insert to mark this binding as most recently used.
    this.bindAffinity(conversationKey, boundId)
    return bound
  }

  /** Bindings currently remembered; exposed for tests and diagnostics. */
  affinitySize(): number {
    return this.affinity.size
  }

  /** Forget every conversation binding (tests, and a settings change). */
  clearAffinity(): void {
    this.affinity.clear()
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
   * `expiry` mode: the account whose one-off credit packs die soonest.
   *
   * Credit packs are use-it-or-lose-it, so spending the dying ones first is
   * strictly better than spreading the spend: an account that expires with
   * credits left is money burnt, while an account whose packs have no deadline
   * loses nothing by waiting. Two accounts expiring at the same instant fall
   * back to the pool order, and an account with no known expiry sorts last —
   * "we have not looked" must never outrank a real deadline.
   *
   * A pool where nobody has a known expiry therefore behaves exactly like
   * priority, which is the honest degradation: without a reading there is
   * nothing to sort by.
   */
  private pickByExpiry(pool: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    let best: WorkBuddyAccount | undefined
    let bestAt = Number.POSITIVE_INFINITY
    for (const account of pool) {
      const at = this.creditExpiry.get(account.id)
      if (at === undefined) continue
      if (at < bestAt) { best = account; bestAt = at }
    }
    return best ?? pool[0]
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
   * - **sticky**: one account per conversation, and a new conversation moves to
   *   the next account in order. Keeps the upstream prompt cache warm within a
   *   conversation while still spreading spend across conversations.
   * - **expiry**: the account whose one-off credit packs expire soonest serves
   *   first, so use-it-or-lose-it credits are spent before they vanish.
   *
   * In every mode an explicit user selection (`prefer`) heads the list, a
   * cooling account is skipped for that model only, and an unrecognised setting
   * falls back to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   *
   * `conversationKey` is only consulted under `sticky`; other modes ignore it.
   */
  async acquire(modelId?: string, region?: WorkBuddyRegion, conversationKey?: string): Promise<WorkBuddyAccount | undefined> {
    if (this.accounts.length === 0) await this.scan()
    // One attempt per account: a token refresh can PROVE a credential revoked
    // (see ensureFresh), which marks that account dead and removes it from the
    // next `available()` call. Looping here means a request still lands on a
    // healthy account in that turn instead of failing over a dead one.
    const maxTries = this.accounts.length + 1
    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      let pool = this.available(Date.now(), modelId, region)
      if (pool.length === 0 && attempt === 0) {
        await this.scan()
        pool = this.available(Date.now(), modelId, region)
      }
      if (pool.length === 0) return undefined

      // An explicit pick wins outright when it is eligible. Reordering the list
      // is not enough now that priority mode draws by weight: the user asked for
      // one account, so the draw should not be able to pick another.
      if (this.preferredId !== undefined) {
        const preferred = pool.find(account => account.id === this.preferredId)
        if (preferred !== undefined && await this.ensureFresh(preferred)) return preferred
      }

      if (this.distribution === 'sticky') {
        const bound = this.affinityAccount(pool, conversationKey)
        if (bound !== undefined && await this.ensureFresh(bound)) return bound
      }

      // `priority` keeps the original behaviour: the head of the ordered list
      // answers until it is limited, which is what a pool of your own accounts is
      // for. `round-robin` walks the cursor, and so does a NEW `sticky`
      // conversation, which is what makes consecutive new chats land on
      // consecutive accounts. `balanced` draws by weight so a quiet pool spreads
      // across accounts instead of draining the first one. `expiry` spends the
      // packs that are about to die before they do.
      const account = this.distribution === 'round-robin' || this.distribution === 'sticky'
        ? this.pickRoundRobin(pool)
        : this.distribution === 'balanced'
          ? this.pickByWeight(pool)
          : this.distribution === 'expiry'
            ? this.pickByExpiry(pool)
            : pool[0]
      // Serving is recorded by noteServed once the upstream answers 200, not
      // here: picking only says which account is being tried, and the shim may
      // still rotate before the request succeeds.
      if (account === undefined) return undefined
      const healthy = await this.ensureFresh(account)
      if (!healthy) continue
      if (this.distribution === 'sticky' && conversationKey !== undefined && conversationKey !== '') {
        this.bindAffinity(conversationKey, account.id)
      }
      return account
    }
    return undefined
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
   *
   * `nearestExpiryMs` is the same reading's nearest one-off pack deadline, or
   * undefined when nothing is about to expire. It is written through, not
   * merged: a pack that has been spent or has died disappears from the next
   * reading, and keeping the stale deadline would pin the pool to an account
   * whose credits are already gone — the opposite of what `expiry` mode wants.
   */
  noteCredits(accountId: string, balance: number, nearestExpiryMs?: number): void {
    if (!Number.isFinite(balance)) return
    if (!this.accounts.some(account => account.id === accountId)) return
    this.creditBalances.set(accountId, balance)
    if (nearestExpiryMs === undefined || !Number.isFinite(nearestExpiryMs)) {
      this.creditExpiry.delete(accountId)
      return
    }
    this.creditExpiry.set(accountId, nearestExpiryMs)
  }

  /** Nearest one-off pack expiry for one account, or undefined when none known. */
  creditExpiryOf(accountId: string): number | undefined {
    return this.creditExpiry.get(accountId)
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
  async refreshAccount(accountId: string, options?: { force?: boolean }): Promise<boolean> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return false
    return await this.ensureFresh(account, options?.force === true)
  }

  /**
   * Cool a whole account because the upstream REJECTED its sign-in (401/403).
   *
   * Called with direct evidence (the request just came back `session_dead`), so
   * it does not need to guess: without this, the next retry of the SAME request
   * picks the same account again — its credential file still claims to be valid
   * — and a request with 8 attempts spends all 8 on one dead account while
   * healthy accounts are never tried.
   */
  penalizeCredentialDead(accountId: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    const until = Date.now() + this.credentialDeadCooldownMs
    account.credentialDeadUntilMs = Math.max(account.credentialDeadUntilMs ?? 0, until)
    this.logger?.warn(
      `dsh-workbuddy-xdpool: ${account.label} sign-in was rejected by the upstream; `
        + `keeping it out of rotation until ${new Date(until).toISOString()} (sign in again to restore it)`,
    )
  }

  /** Put an account back in rotation after its sign-in was proven good again. */
  clearCredentialDead(accountId: string): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.credentialDeadUntilMs = 0
  }

  /** Accounts currently kept out of rotation because their sign-in was rejected. */
  deadCredentials(): readonly WorkBuddyAccount[] {
    const now = Date.now()
    return this.accounts.filter(account => (account.credentialDeadUntilMs ?? 0) > now)
  }

  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   *
   * `force` skips the "is it expiring?" gate. That gate is a cost optimisation,
   * not a correctness rule: it exists so a healthy token is not re-fetched on
   * every acquire. After the upstream has ALREADY rejected the token, the gate
   * is actively wrong — a revoked token keeps its future `expiresAtMs` — and the
   * caller needs the refresh attempted so the credential can be proven dead.
   *
   * Returns true when the token is known good afterwards (refreshed, or still
   * valid), false when the credential was proven dead.
   */
  private async ensureFresh(account: WorkBuddyAccount, force = false): Promise<boolean> {
    if (this.client === undefined) return true
    const credential = account.credential
    const expiring = credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs
    if (!expiring && !force) return true
    const existing = this.refreshInflight.get(account.id)
    if (existing !== undefined) {
      await existing
      return (account.credentialDeadUntilMs ?? 0) <= Date.now()
    }
    const run = (async (): Promise<boolean> => {
      if (credential.refreshToken === '') {
        // Nothing to refresh with; only worth failing if already expired.
        if (credential.expiresAtMs > Date.now() + 30_000) return true
        this.logger?.warn(`dsh-workbuddy-xdpool: ${account.label} token expired with no refresh token; sign in again`)
        this.penalizeCredentialDead(account.id)
        return false
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
        // A working refresh is the strongest possible proof the sign-in is
        // alive again — undo any earlier dead mark.
        this.clearCredentialDead(account.id)
        this.logger?.info?.(`dsh-workbuddy-xdpool: refreshed token for ${account.label}`)
        return true
      } catch (error: unknown) {
        if (isCredentialDeadError(error)) {
          // The upstream said the refresh token itself is gone
          // (`invalid_grant: Offline user session not found`). The stored expiry
          // is meaningless here — it stays in the future for a revoked token —
          // so mark the account dead instead of retrying it forever.
          this.penalizeCredentialDead(account.id)
          this.logger?.warn?.(
            `dsh-workbuddy-xdpool: ${account.label} refresh token was revoked upstream; sign in again to restore it`,
            error,
          )
          return false
        }
        if (credential.expiresAtMs > Date.now() + 30_000) {
          this.logger?.warn?.(`dsh-workbuddy-xdpool: token refresh failed but token still valid for ${account.label}`, error)
        } else {
          this.logger?.error?.(`dsh-workbuddy-xdpool: token refresh failed and token expired for ${account.label}`, error)
        }
        return true
      }
    })()
    this.refreshInflight.set(account.id, run)
    try {
      return await run
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
      // A rejected sign-in is a cooldown too, and "clear all cooldowns" is the
      // user saying "try everything again". If the credential really is dead the
      // next request re-marks it, so the cost of clearing is one failed attempt
      // and the benefit is that a working account is never hidden by a stale mark.
      account.credentialDeadUntilMs = 0
    }
  }

  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status(): { count: number; cooling: number; dead: number; lastScanAtMs: number } {
    const now = Date.now()
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter(account => account.cooldownUntilMs > now).length,
      dead: this.accounts.filter(account => (account.credentialDeadUntilMs ?? 0) > now).length,
      lastScanAtMs: this.lastScanAtMs,
    }
  }
}
