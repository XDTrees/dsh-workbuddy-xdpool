/**
 * Node-free constants and types shared by the Host and browser halves of the
 * WorkBuddy XD Pool settings card.
 *
 * Pool's runtime state already lives in `src/status.ts` (`buildStatus` /
 * `WorkBuddyStatus`); this module only carves the cross-domain (Host→browser)
 * JSON document into a shape that stays token-free and matches what the
 * browser card renders. Route paths are plugin-owned and mounted on the Host's
 * same-origin web server (see `src/web-status.ts`).
 *
 * @module dsh-workbuddy-xdpool/status-paths
 */

/** Plugin-owned read-only pool status endpoint (account rows + models + shim). */
export const POOL_STATUS_PATH = '/plugins/dsh-workbuddy-xdpool/status'
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
export const POOL_RESCAN_PATH = '/plugins/dsh-workbuddy-xdpool/accounts/rescan'
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
export const POOL_RESET_COOLDOWN_PATH = '/plugins/dsh-workbuddy-xdpool/cooldowns/reset'

/** One pool account's row, token-free. */
export interface PoolWebAccount {
  id: string
  label: string
  nickname?: string
  domain: string
  /** ISO timestamp; absent when the credential carries no expiry. */
  expiresAt?: string
  /** Account-wide cooldown (every model blocked); only after a no-model penalize. */
  cooling: boolean
  /** ISO timestamp when the account-wide 429 cooldown lifts; only while cooling. */
  cooldownUntil?: string
  /**
   * Per-model cooldowns currently active. The account is NOT `cooling` while a
   * model is limited — its other models still serve — but each entry tells the
   * card which model is out until when (e.g. `hy4-preview` cooling to 10:14,
   * `hy3` normal).
   */
  modelCooldowns?: ReadonlyArray<{ modelId: string; until: string }>
  rateLimitHits: number
  /** ISO timestamp of the last successful use (best-effort pool bookkeeping). */
  lastUsedAt?: string
  /** Aggregated credit summary for the account, read-only. */
  credits?: PoolWebCredits
  creditsError?: string
}

/** One credit package (as surfaced by the pool's upstream client), node-free. */
export interface PoolWebCreditPackage {
  packageName: string
  remain?: number
  size?: number
  /** CapacityType 4 — refreshed each cycle and never expires. */
  monthly?: boolean
  /** Next cycle refresh point, ms. */
  cycleRefreshMs?: number
  /** One-off expiry, ms. */
  expiresAtMs?: number
}

/** Aggregated credit answer the card renders under one account. */
export interface PoolWebCredits {
  total?: number
  packages: readonly PoolWebCreditPackage[]
  /** Credits expiring within 3 days. */
  expiringSoon?: number
  /** When the nearest package expires, ms. */
  nearestExpiryMs?: number
}

/** One model the pool exposes to DSH, with cost / free tags. */
export interface PoolWebModel {
  id: string
  name: string
  /** Relative credit cost, e.g. 0.79 for x0.79. */
  multiplier?: number
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[]
  supportsImages: boolean
  contextWindow: number
}

/** The JSON document the pool card renders. */
export interface PoolWebStatus {
  ok: boolean
  accounts: readonly PoolWebAccount[]
  /** The next account the pool would use (rotation cursor). */
  activeAccountId?: string
  cooling: number
  models: readonly PoolWebModel[]
  shim: { running: boolean; baseUrl?: string }
}
