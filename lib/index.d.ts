import z from "@deepseek-ai/schemastery";
import { Api, Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context, Context as Context$1 } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/upstream.d.ts
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** Token-refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** One CLI-usable model, carrying what the plugin card displays. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  creditMultiplier?: number;
  /** Upstream image-input flag. Both gateways spell it `supportsImages`; some entries
   * also carry `disabledMultimodal`, the negative spelling. Reading anything else
   * reported every model as text-only, which made a vision shim register a second
   * route under the same display name and split the model picker group.
   */
  supportsImages?: boolean;
  reasoning?: {
    supportedEfforts?: readonly string[];
    defaultEffort?: string;
    canDisableThinking?: boolean;
  };
  descriptionZh?: string;
  descriptionEn?: string;
  supportsToolCall?: boolean;
}
/** One billing package, already normalised. */
interface WorkBuddyCreditPackage {
  packageName: string;
  remain: number;
  size: number;
  monthly: boolean;
  refreshAtMs?: number;
  expiresAtMs?: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  packages: readonly WorkBuddyCreditPackage[];
  expiringSoon: number;
  nearestExpiryMs?: number;
}
/** Daily check-in activity state. */
interface WorkBuddyCheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  /** Upstream-supplied button label; the card falls back to its own copy. */
  claimButtonText?: string;
}
/** Daily check-in claim result. */
interface WorkBuddyCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/** Result of one upstream chat attempt. */
type ChatStreamResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  kind: UpstreamErrorKind;
  status: number;
  message: string;
};
interface UpstreamClientOptions {
  /** Injectable fetch, primarily for tests. */
  fetchImpl?: typeof fetch;
  /** Client version string sent to the upstream. */
  clientVersion?: string;
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
/** The two gateways WorkBuddy serves: the domestic one and the international one. */
type WorkBuddyRegion = 'cn' | 'global';
/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 * Body markers win over status, because the upstream reuses 400/200 for
 * several distinct conditions.
 */
export declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Recognises an epoch-millisecond field and the Chinese-localised sentence
 * form, so the pool can resume exactly when the window reopens.
 */
export declare function parseRateLimitReset(body: string): number | undefined;
export declare class WorkBuddyUpstreamClient {
  private readonly fetchImpl;
  private readonly clientVersion;
  constructor(options?: UpstreamClientOptions);
  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), and flatten `tool_choice` into its string form.
   */
  prepareChatBody(raw: string): string;
  /** Forward one chat completion. Never throws for upstream failures. */
  chatStream(credential: WorkBuddyCredential, prepared: string, signal?: AbortSignal): Promise<ChatStreamResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
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
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
  /** Read-only credits query, aggregated by package. Does not consume credits. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /** Query today's check-in status without changing account state. */
  fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus>;
  /** Claim today's check-in reward. The browser route guards this mutation. */
  claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim>;
  /** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
  credits(credential: WorkBuddyCredential): Promise<{
    ok: true;
    data: unknown;
  } | {
    ok: false;
    message: string;
  }>;
}
//#endregion
//#region src/accounts.d.ts
/** Minimal upstream surface the pool needs to refresh a token (no circular import). */
interface TokenRefresher {
  refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresInSec?: number;
    domain?: string;
  }>;
}
/** Live auth file name the WorkBuddy desktop app writes. */
export declare const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Snapshot files left behind by previous logins share this prefix. */
/** Env override for the auth file or its directory. */
export declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** One parsed WorkBuddy credential. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  /**
   * When the upstream says it issued this token (`auth.lastRefreshTime`).
   *
   * This, not `expiresAtMs`, is the reliable freshness signal: the upstream
   * never rewrites a stored expiry when it revokes a token, so a long-dead
   * backup can claim to expire later than the token that actually works.
   * Absent on documents the desktop app did not write (the plugin's own
   * refreshed copy, older builds).
   */
  lastRefreshAtMs?: number;
  nickname?: string;
  uin?: string;
  uid?: string;
  enterpriseId?: string;
  domain: string;
  /** Where this credential came from, for diagnostics. */
  sourcePath: string;
}
/** An account is a credential plus pool bookkeeping. */
interface WorkBuddyAccount {
  /** Stable pool key: sha256 of the billing identity. */
  id: string;
  /** Short human label, e.g. `青楫渡` or `青楫渡#29890334`. */
  label: string;
  credential: WorkBuddyCredential;
  /**
   * Epoch ms until which this account is skipped for EVERY model. Only set by
   * account-wide cooldowns (callers that penalize without a model id). The
   * upstream rate limit is actually per-model ("可切换其他模型继续使用"), so
   * routine 429s are tracked in {@link modelCooldowns} instead and never ban a
   * whole account.
   */
  cooldownUntilMs: number;
  /**
   * Per-model cooldowns, keyed by upstream model id → epoch ms until that model
   * on THIS account is skipped. A 429 on `hy4-preview` cools only that model
   * here; `hy3`/`glm-*` on the same account keep serving.
   */
  modelCooldowns: Record<string, number>;
  /** Consecutive rate-limit hits, for diagnostics. */
  rateLimitHits: number;
}
/**
 * Platform-default directories holding the desktop app's auth files.
 * Windows probes Local before Roaming; a redirected profile still resolves
 * through the env location.
 */
export declare function defaultDesktopAuthDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/**
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 */
export declare function parseWorkBuddyAuth(text: string, sourcePath: string): WorkBuddyCredential | undefined;
export declare function workbuddyAccountId(credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>): string;
/** Every directory the pool should scan, in probe order. */
export declare function candidateAuthDirs(env?: NodeJS.ProcessEnv): string[];
/** How the pool chooses which account serves the next request. */
type AccountDistribution = 'priority' | 'round-robin';
interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: {
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[];
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number;
  /** Upstream client used to refresh near-expiry tokens. */
  client?: TokenRefresher;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
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
  distribution?: AccountDistribution;
}
/**
 * Read-only pool of every discovered WorkBuddy account, with rate-limit
 * cooldown and round-robin failover.
 */
export declare class WorkBuddyAccountPool {
  private readonly logger;
  private authDirs;
  private cooldownMs;
  private readonly client;
  private readonly refreshMarginMs;
  private accounts;
  private distribution;
  /** Cursor for round-robin mode; unused under priority distribution. */
  private cursor;
  private lastScanAtMs;
  private preferredId;
  private refreshInflight;
  constructor(options?: AccountPoolOptions);
  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options: {
    authDirs?: readonly string[];
    cooldownMs?: number;
    distribution?: AccountDistribution;
  }): void;
  /** Rescan the auth directories and merge newly discovered accounts. */
  scan(): Promise<WorkBuddyAccount[]>;
  /** All accounts, cooldown state included. */
  list(region?: WorkBuddyRegion): readonly WorkBuddyAccount[];
  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics).
   */
  private available;
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
  acquire(modelId?: string, region?: WorkBuddyRegion): Promise<WorkBuddyAccount | undefined>;
  /** Pin the account the plugin card should prefer; tokens stay out of settings. */
  /** How the pool currently spreads requests. Shown on the card. */
  currentDistribution(): AccountDistribution;
  prefer(accountId: string | undefined): void;
  /** Best-effort refresh of one account after a session-dead upstream answer. */
  refreshAccount(accountId: string): Promise<void>;
  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   */
  private ensureFresh;
  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   */
  penalize(accountId: string, resetAtMs?: number, modelId?: string): void;
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns(): void;
  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status(): {
    count: number;
    cooling: number;
    lastScanAtMs: number;
  };
}
//#endregion
//#region src/catalog.d.ts
/** One model the provider exposes. */
interface WorkBuddyModelInfo {
  id: string;
  /** Display name; the multiplier is appended for the picker. */
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Relative credit cost, e.g. 0.79 for `x0.79`. */
  multiplier?: number;
  /** Upstream-declared thinking levels. */
  supportedEfforts?: readonly string[];
  supportsImages: boolean;
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[];
}
/** Static fallback used before the first live catalog fetch. */
export declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/** Live catalog with a static fallback behind it. */
export declare class WorkBuddyCatalog {
  private models;
  private listeners;
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection;
  current(): readonly WorkBuddyModelInfo[];
  /**
   * The models DSH should actually offer, after applying the user's selection:
   * disabled models are dropped, an explicit image list overrides the upstream
   * capability flag, and a per-model budget caps the advertised window.
   *
   * An absent `enabledModelIds` means "everything" — a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible(): readonly WorkBuddyModelInfo[];
  /** Replace the catalog and notify the adapter to rebuild its model list. */
  update(models: readonly WorkBuddyModelInfo[]): void;
  /** Restore the static fallback, e.g. when the upstream stops answering. */
  reset(): void;
  /** Replace the user's selection; the adapter rebuilds from `visible()`. */
  applySelection(selection: ModelSelection): void;
  /** The selection currently in force, for the card's save round-trip. */
  currentSelection(): ModelSelection;
  onChange(listener: () => void): () => void;
  find(id: string): WorkBuddyModelInfo | undefined;
  /** Replace the catalog from the live upstream list; keeps the fallback if empty. */
  updateFromUpstream(models: readonly WorkBuddyUpstreamModel[]): void;
  private notify;
}
/** The user's model selection, as stored in the settings section. */
interface ModelSelection {
  /** Absent = every model in the catalog is offered. */
  enabledModelIds?: readonly string[];
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[];
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
//#endregion
//#region src/shim.d.ts
interface ShimLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
interface WorkBuddyShim {
  ready: Promise<void>;
  baseUrl(): string;
  token(): string;
  close(): Promise<void>;
}
interface WorkBuddyShimOptions {
  pool: WorkBuddyAccountPool;
  client: WorkBuddyUpstreamClient;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
  /**
   * Restrict this shim to one gateway. Two shims run side by side — one
   * per region — and each must only ever draw accounts that belong to its
   * own gateway. Absent means "every account" (a single-region deployment).
   */
  region?: WorkBuddyRegion;
  /** Max accounts to try per request before giving up. */
  maxAttempts?: number;
}
export declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
export declare const WORKBUDDY_POOL_PROVIDER = "workbuddy-xdpool";
interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim;
  catalog: WorkBuddyCatalog;
  /** Plugin context; the pi-ai adapter reads `attachments`/`fs` from it. */
  ctx: Context$1;
  providerId?: string;
  displayName?: string;
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  providerId: string;
  displayName: string;
  adapter: PiAiAdapter;
  /** Rebuild the pi-ai model list from the current catalog. */
  buildModels: () => Model<Api>[];
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. `getModels` re-reads the live catalog, and every
 * model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup. Call only after `shim.ready`.
 */
export declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/status.d.ts
/** One account's status row. */
interface AccountStatus {
  id: string;
  label: string;
  nickname?: string;
  domain: string;
  /** ISO timestamp when the access token expires. */
  expiresAt?: string;
  /** Account-wide cooldown (every model blocked). */
  cooling: boolean;
  cooldownUntil?: string;
  /** Per-model cooldowns active right now (modelId → ISO until); the account
   *  itself is not `cooling` while only some models are limited. */
  modelCooldowns?: readonly {
    modelId: string;
    until: string;
  }[];
  rateLimitHits: number;
  /** Read-only aggregated credit summary for the account. */
  credits?: WorkBuddyCredits;
  creditsError?: string;
  sourcePath: string;
}
/** Whole-plugin status document. */
interface WorkBuddyStatus {
  ok: boolean;
  accounts: AccountStatus[];
  activeAccountId?: string;
  cooling: number;
  models: {
    id: string;
    name: string;
    multiplier?: number;
    tags?: readonly string[];
  }[];
  shim: {
    running: boolean;
    baseUrl?: string;
  };
}
interface StatusOptions {
  pool: WorkBuddyAccountPool;
  /** The catalog to report. Regional callers pass their own region's. */
  catalog: WorkBuddyCatalog;
  client: WorkBuddyUpstreamClient;
  shim?: {
    running: boolean;
    baseUrl?: string;
  };
  /** Query credits per account. Off for cheap diagnostics runs. */
  includeCredits?: boolean;
}
/** Build the status document. Never throws. */
export declare function buildStatus(options: StatusOptions): Promise<WorkBuddyStatus>;
/** Format the status document for a terminal. */
export declare function formatStatus(status: WorkBuddyStatus): string;
/** Format the per-model credit multipliers. */
export declare function formatRates(status: WorkBuddyStatus): string;
//#endregion
//#region src/status-paths.d.ts
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
export declare const POOL_STATUS_PATH = "/plugins/dsh-workbuddy-xdpool/status";
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
export declare const POOL_RESCAN_PATH = "/plugins/dsh-workbuddy-xdpool/accounts/rescan";
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
export declare const POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-workbuddy-xdpool/cooldowns/reset";
/** Plugin-owned daily check-in action endpoint (claim today's reward). */
export declare const POOL_CHECKIN_PATH = "/plugins/dsh-workbuddy-xdpool/checkin";
/** Plugin-owned model-selection save endpoint (writes the settings section). */
export declare const POOL_MODELS_SAVE_PATH = "/plugins/dsh-workbuddy-xdpool/models/save";
/** One pool account's row, token-free. */
interface PoolWebAccount {
  id: string;
  label: string;
  nickname?: string;
  domain: string;
  /** ISO timestamp; absent when the credential carries no expiry. */
  expiresAt?: string;
  /** Account-wide cooldown (every model blocked); only after a no-model penalize. */
  cooling: boolean;
  /** ISO timestamp when the account-wide 429 cooldown lifts; only while cooling. */
  cooldownUntil?: string;
  /**
   * Per-model cooldowns currently active. The account is NOT `cooling` while a
   * model is limited — its other models still serve — but each entry tells the
   * card which model is out until when (e.g. `hy4-preview` cooling to 10:14,
   * `hy3` normal).
   */
  modelCooldowns?: ReadonlyArray<{
    modelId: string;
    until: string;
  }>;
  rateLimitHits: number;
  /** ISO timestamp of the last successful use (best-effort pool bookkeeping). */
  lastUsedAt?: string;
  /** Aggregated credit summary for the account, read-only. */
  credits?: PoolWebCredits;
  creditsError?: string;
  /**
   * Today's check-in state for this account, read-only. Present only when the
   * per-account check-in probe succeeded and the program is active. The card
   * renders one claim button per account, so a multi-account pool can collect
   * every account's daily reward without switching accounts by hand.
   */
  checkin?: PoolWebCheckin;
  checkinError?: string;
}
/** One credit package (as surfaced by the pool's upstream client), node-free. */
interface PoolWebCreditPackage {
  packageName: string;
  remain?: number;
  size?: number;
  /** CapacityType 4 — refreshed each cycle and never expires. */
  monthly?: boolean;
  /** Next cycle refresh point, ms. */
  cycleRefreshMs?: number;
  /** One-off expiry, ms. */
  expiresAtMs?: number;
}
/** Aggregated credit answer the card renders under one account. */
interface PoolWebCredits {
  total?: number;
  packages: readonly PoolWebCreditPackage[];
  /** Credits expiring within 3 days. */
  expiringSoon?: number;
  /** When the nearest package expires, ms. */
  nearestExpiryMs?: number;
}
/**
 * Daily check-in state the card renders under one account's credits. Mirrors
 * the upstream activity endpoint, minus anything the browser does not need.
 */
interface PoolWebCheckin {
  /** The activity is running; a claim button is offered only while true. */
  active: boolean;
  /** Already collected today — the button renders as a done state. */
  todayCheckedIn: boolean;
  /** Consecutive days checked in. */
  streakDays: number;
  /** Credits a single day grants. */
  dailyCredit: number;
  /** Credits collected today (0 before claiming). */
  todayCredit: number;
  /** Today is a streak milestone day. */
  isStreakDay: boolean;
  /** The day count the next milestone lands on. */
  nextStreakDay: number;
  /** Bonus credits granted on a milestone day. */
  streakBonusCredit: number;
}
/** Result of one claim, so the card can confirm what was collected. */
interface PoolWebCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/** One model the pool exposes to DSH, with cost / free tags. */
interface PoolWebModel {
  id: string;
  name: string;
  /** Relative credit cost, e.g. 0.79 for x0.79. */
  multiplier?: number;
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[];
  /** Effective image support after the user's per-model toggle. */
  supportsImages: boolean;
  /** Effective context window after the user's budget cap. */
  contextWindow: number;
  /** The window the upstream advertises, before any cap. */
  nativeContextWindow: number;
  /** Upstream output ceiling, so the card can show both limits. */
  maxOutputTokens: number;
  /** Thinking levels the upstream declares, when it declares any. */
  supportedEfforts?: readonly string[];
  /** Whether this model is currently enabled in the picker. */
  enabled: boolean;
}
/** The user's saved model selection, echoed back so the card can diff a draft. */
interface PoolWebModelSelection {
  /** Absent = every model is enabled. */
  enabledModelIds?: readonly string[];
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[];
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
/** The JSON document the pool card renders. */
interface PoolWebStatus {
  ok: boolean;
  accounts: readonly PoolWebAccount[];
  /** The next account the pool would use (rotation cursor). */
  activeAccountId?: string;
  cooling: number;
  models: readonly PoolWebModel[];
  /** The saved selection the card diffs its draft against. */
  selection: PoolWebModelSelection;
  /**
   * How the pool spreads requests: `priority` drains one account before
   * moving on, `round-robin` splits the spend evenly.
   */
  distribution: PoolDistribution;
  /** Which region this document describes. */
  region: PoolRegion;
  /** Every region holding at least one account, in display order. */
  regions: readonly PoolRegion[];
  shim: {
    running: boolean;
    baseUrl?: string;
  };
}
/**
 * The two gateways, matching the provider ids the host registers. `cn` is the
 * domestic gateway (`copilot.tencent.com` / `codebuddy.cn`); `global` is the
 * international one (`workbuddy.ai`).
 */
type PoolRegion = 'cn' | 'global';
/** How the pool spreads requests across its accounts. */
type PoolDistribution = 'priority' | 'round-robin';
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
export declare const name = "llm-workbuddy-xdpool";
/** The model registry required before the provider can register. */
export declare const inject: string[];
/**
 * Settings namespace for the WorkBuddy XD Pool card. Registering a section here
 * is what makes the provider appear on the Models settings page and causes the
 * Host to mount the plugin's client card under Plugin configuration — exactly
 * the mechanism the single-account connector uses.
 */
export declare const WORKBUDDY_POOL_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path override. */
  authFile?: string;
  /** Rate-limit cooldown per account, milliseconds. */
  cooldownMs?: number;
  /**
   * How the pool spreads requests across accounts.
   *
   * `priority` (default) drains one account before moving to the next, which
   * is what a pool of your own accounts is for. `round-robin` splits the
   * spend evenly instead. Absent reads as `priority`.
   */
  distribution?: 'priority' | 'round-robin';
  /**
   * Model ids enabled in the picker. Absent means "every model the catalog
   * advertises" — an unconfigured install should never present an empty model
   * list just because the key is missing.
   */
  enabledModelIds?: string[];
  /**
   * Model ids that additionally accept image input. Absent means "follow the
   * upstream capability flag"; an explicit list is authoritative for the models
   * it mentions and leaves the rest to the catalog.
   */
  imageModelIds?: string[];
  /**
   * Per-model context-window override, keyed by model id. The upstream can
   * advertise more than DSH wants to hand a single turn, so the card lets the
   * user cap a model without touching the catalog.
   */
  contextBudgets?: Record<string, number>;
}
/** Upper bound the card offers as the "default" context window, in tokens. */
export declare const DEFAULT_CONTEXT_BUDGET = 200000;
/**
 * Plugin configuration schema.
 *
 * Mirrors the shape the settings section stores. Every field carries a default
 * so a config that never touched the card still folds cleanly: a field whose
 * schema declares no default is read as absent by the settings fold. That is
 * also why `contextBudgets` is a real dictionary (`z.dict`) - an open object
 * schema reads as "an object with no fields" and the fold then throws while
 * the provider row is rendered.
 */
export declare const Config: z<Config>;
/** Everything the CLI needs from a live plugin instance. */
export interface WorkBuddyPoolApi {
  pool: WorkBuddyAccountPool;
  /** One catalog per region, matching the two registered providers. */
  catalogs: Readonly<Record<WorkBuddyRegion, WorkBuddyCatalog>>;
  client: WorkBuddyUpstreamClient;
  shim: WorkBuddyShim;
  adapter: WorkBuddyAdapter | undefined;
  rescan(): Promise<number>;
  status(includeCredits?: boolean): Promise<Awaited<ReturnType<typeof buildStatus>>>;
  resetCooldowns(): void;
}
/** The live API, or undefined when the plugin has not applied yet. */
export declare function currentApi(): WorkBuddyPoolApi | undefined;
/** Test seam: install an API instance without booting cordis. */
export declare function setApi(next: WorkBuddyPoolApi | undefined): void;
/** Assemble the runtime objects without registering anything. */
/**
 * Assemble the runtime objects without registering anything.
 *
 * One catalog per region, mirroring the two shims: the CN and global gateways
 * do not advertise the same roster, and a shared catalog meant the picker showed
 * whichever list happened to be fetched first (always the CN one, since the
 * seeding step read `accounts[0]`).
 */
export declare function createCore(logger?: {
  warn(...args: unknown[]): void;
}): {
  pool: WorkBuddyAccountPool;
  catalogs: {
    readonly cn: WorkBuddyCatalog;
    readonly global: WorkBuddyCatalog;
  };
  client: WorkBuddyUpstreamClient;
};
/**
 * Start the loopback endpoint, register the `workbuddy-xdpool` provider, and
 * discover accounts. The provider registers only after `shim.ready` resolves,
 * because its models read the shim origin at construction time.
 */
export declare function apply(ctx: Context, config?: Config): void;
//#endregion
export type { AccountStatus, Context, ModelSelection, PoolWebCheckin, PoolWebCheckinClaim, PoolWebModel, PoolWebModelSelection, PoolWebStatus, UpstreamErrorKind, WorkBuddyAccount, WorkBuddyAdapter, WorkBuddyCredential, WorkBuddyModelInfo, WorkBuddyShim, WorkBuddyStatus };