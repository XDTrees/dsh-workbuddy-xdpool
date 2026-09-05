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
const SNAPSHOT_PREFIX = 'workbuddy-desktop.'

/** Env override for the auth file or its directory. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** One parsed WorkBuddy credential. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
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
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 */
export function parseWorkBuddyAuth(text: string, sourcePath: string): WorkBuddyCredential | undefined {
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

  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined

  // Skip documents whose refresh window has already closed: they cannot recover.
  const refreshExpiresAtMs =
    typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  if (refreshExpiresAtMs !== undefined && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) {
    return undefined
  }

  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    ...optionalString(identity['nickname']) === undefined ? {} : { nickname: optionalString(identity['nickname']) },
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
async function authFilesIn(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const files = entries.filter(name => {
    if (name === WORKBUDDY_LIVE_FILENAME) return true
    // Snapshot: "workbuddy-desktop.<timestamp>.<pid>.<uuid>.info"
    return name.startsWith(SNAPSHOT_PREFIX) && name.endsWith('.info')
  })
  // Newest snapshot first so the freshest token wins when uids collide.
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  return files.map(name => join(dir, name))
}

async function readCredential(path: string): Promise<WorkBuddyCredential | undefined> {
  try {
    return parseWorkBuddyAuth(await readFile(path, 'utf8'), path)
  } catch {
    return undefined
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

export interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[]
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number
  /** Upstream client used to refresh near-expiry tokens. */
  client?: TokenRefresher
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/**
 * Read-only pool of every discovered WorkBuddy account, with rate-limit
 * cooldown and round-robin failover.
 */
export class WorkBuddyAccountPool {
  private readonly logger: AccountPoolOptions['logger']
  private authDirs: readonly string[]
  private cooldownMs: number
  private readonly client: TokenRefresher | undefined
  private readonly refreshMarginMs: number
  private accounts: WorkBuddyAccount[] = []
  private cursor = 0
  private lastScanAtMs = 0
  private preferredId: string | undefined
  private refreshInflight = new Map<string, Promise<void>>()

  constructor(options: AccountPoolOptions = {}) {
    this.logger = options.logger
    this.authDirs = options.authDirs ?? candidateAuthDirs()
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.client = options.client
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
  }

  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options: { authDirs?: readonly string[]; cooldownMs?: number }): void {
    if (options.authDirs !== undefined && options.authDirs.length > 0) {
      this.authDirs = options.authDirs
    }
    if (options.cooldownMs !== undefined && options.cooldownMs >= 1000) {
      this.cooldownMs = options.cooldownMs
    }
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
      // Prefer the credential with the longest remaining lifetime.
      if ((credential.expiresAtMs ?? 0) > (existing.credential.expiresAtMs ?? 0)) {
        byId.set(id, { ...existing, credential, label: accountLabel(credential) })
      }
    }

    this.accounts = [...byId.values()]
    this.lastScanAtMs = Date.now()
    return this.accounts
  }

  /** All accounts, cooldown state included. */
  list(): readonly WorkBuddyAccount[] {
    return this.accounts
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
  private available(now: number, modelId?: string): WorkBuddyAccount[] {
    return this.accounts.filter(account => {
      if (account.cooldownUntilMs > now) return false
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false
      return true
    })
  }

  /**
   * Pick the next usable account for an optional model. Scans on first use,
   * and rescans when every known account is cooling down — a fresh desktop
   * login is the usual way out of an exhausted pool. A preferred
   * (user-selected) account that is healthy is tried first; otherwise the
   * cursor round-robins so consecutive requests spread across accounts and a
   * still-cooling preferred account is skipped.
   */
  async acquire(modelId?: string): Promise<WorkBuddyAccount | undefined> {
    if (this.accounts.length === 0) await this.scan()
    let pool = this.available(Date.now(), modelId)
    if (pool.length === 0) {
      await this.scan()
      pool = this.available(Date.now(), modelId)
    }
    if (pool.length === 0) return undefined

    // Start the rotation at the preferred account when it is usable; the cursor
    // still advances on every acquisition so failover spreads across accounts.
    let start = this.cursor % pool.length
    if (this.preferredId !== undefined) {
      const preferredIndex = pool.findIndex(account => account.id === this.preferredId)
      if (preferredIndex !== -1) start = preferredIndex
    }

    for (let step = 0; step < pool.length; step += 1) {
      const account = pool[(start + step) % pool.length]
      if (account === undefined) continue
      await this.ensureFresh(account)
      this.cursor = (start + step + 1) % pool.length
      return account
    }
    return pool[0]
  }

  /** Pin the account the plugin card should prefer; tokens stay out of settings. */
  prefer(accountId: string | undefined): void {
    this.preferredId = accountId
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
