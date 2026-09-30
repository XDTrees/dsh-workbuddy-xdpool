/**
 * Per-model daily usage ledger.
 *
 * A free or quota-limited model costs no credits, so the balance-difference
 * method the reserve feature relies on cannot see it: the balance simply does
 * not move. The upstream still enforces a per-model daily allowance, and it
 * surfaces only as a 429 that cools the model on one account. Nothing in the
 * pool then answers "how much of today's allowance has this model already
 * used", which is the question the card has to answer before it can warn.
 *
 * So usage is counted here, keyed by (account, model, local day), from what the
 * upstream itself reports: the request count, and the token counts carried in
 * the SSE `usage` frame when the gateway sends one.
 *
 * On disk the ledger keeps the last {@link USAGE_RETENTION_DAYS} days of these
 * buckets, which is what lets the card show a trend rather than a single day.
 * Today is always the LAST entry and every reader asks for it by date, so a
 * document written by an older build — one flat day — still reads correctly.
 * Anything older than the retention window is dropped as the document is
 * written, so the file cannot grow without bound.
 *
 * History starts when this build first runs: earlier usage was never persisted
 * and cannot be reconstructed, so the trend begins on the day of the upgrade.
 *
 * @module dsh-workbuddy-xdpool/usage
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginDataDir } from './ignored.ts'

/** File holding the daily usage ledger, inside `pluginDataDir`. */
export const USAGE_FILE_NAME = 'usage.json'

/**
 * How many days the ledger keeps, today included.
 *
 * 30 days is a month of trend: enough to see a weekly rhythm, small enough that
 * the document stays a few tens of kilobytes even on a busy pool.
 */
export const USAGE_RETENTION_DAYS = 30

/** Absolute path of the usage ledger. */
export function usageLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), USAGE_FILE_NAME)
}

/**
 * One model's counters for one account on one day.
 *
 * `requests` counts every completed stream this account served for the model;
 * `tokens` is 0 when the upstream reported no usage at all, which is why the
 * two are tracked separately — a card showing "3 requests, 0 tokens" is
 * telling the truth about a gateway that sends no usage, whereas folding the
 * tokens into an estimate would invent a number.
 */
export interface UsageCounters {
  /** Completed requests served by this account for this model today. */
  requests: number
  /** Prompt tokens, summed over those requests (0 when unreported). */
  promptTokens: number
  /** Completion tokens, summed over those requests (0 when unreported). */
  completionTokens: number
  /** Requests that carried a usable upstream `usage` frame. */
  reportedRequests: number
  /** ISO timestamp of the most recent request. */
  lastUsedAt: string
}

/**
 * One day's counters: every account, every model.
 *
 * `accounts` maps account id → model id → counters. The nesting is nested
 * rather than a flat `accountId/modelId` key because both halves of the key are
 * opaque upstream strings that can contain any character; a separator-based key
 * would collide on a model id that happens to contain the separator.
 */
export interface UsageDay {
  /** Local day the counters belong to, `YYYY-MM-DD`. */
  date: string
  accounts: Record<string, Record<string, UsageCounters>>
}

/**
 * The whole ledger: an ordered list of days, oldest first.
 *
 * A list rather than a `date → day` map so the days keep a stable order without
 * anyone having to sort them on read, and so "today" is simply the last entry.
 * Every consumer that only cares about one day asks for it by date, which is
 * what keeps this backwards-compatible with a document holding a single day.
 */
export interface UsageLedger {
  /** Oldest first; the last entry is the most recent day held. */
  days: readonly UsageDay[]
}

/** `YYYY-MM-DD` in local time, matching how every other day key is built. */
export function localDayKey(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** An empty ledger holding one day. */
export function emptyLedger(date: string = localDayKey()): UsageLedger {
  return { days: [{ date, accounts: {} }] }
}

/** An empty day. */
export function emptyDay(date: string = localDayKey()): UsageDay {
  return { date, accounts: {} }
}

/**
 * Day keys for the last `count` days, ending today, oldest first.
 *
 * Built by walking back whole calendar days rather than by subtracting
 * milliseconds: a day is not always 86,400 seconds long, and a DST boundary
 * would silently skip or repeat a key.
 */
export function recentDayKeys(count: number = USAGE_RETENTION_DAYS, from: Date = new Date()): string[] {
  const keys: string[] = []
  for (let back = count - 1; back >= 0; back -= 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - back)
    keys.push(localDayKey(day))
  }
  return keys
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Read one day's `accounts` map out of a decoded document. */
function parseAccounts(raw: unknown): Record<string, Record<string, UsageCounters>> {
  if (typeof raw !== 'object' || raw === null) return {}
  const accounts: Record<string, Record<string, UsageCounters>> = {}
  for (const [accountId, modelsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (accountId === '' || typeof modelsRaw !== 'object' || modelsRaw === null) continue
    const models: Record<string, UsageCounters> = {}
    for (const [modelId, countersRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
      if (modelId === '' || typeof countersRaw !== 'object' || countersRaw === null) continue
      const counters = countersRaw as Record<string, unknown>
      const requests = toCount(counters['requests'])
      if (requests === 0) continue
      models[modelId] = {
        requests,
        promptTokens: toCount(counters['promptTokens']),
        completionTokens: toCount(counters['completionTokens']),
        reportedRequests: toCount(counters['reportedRequests']),
        lastUsedAt: typeof counters['lastUsedAt'] === 'string' ? counters['lastUsedAt'] : '',
      }
    }
    if (Object.keys(models).length > 0) accounts[accountId] = models
  }
  return accounts
}

/**
 * Normalize a decoded document into a ledger.
 *
 * Tolerant on purpose, exactly like the ignore list: this file is written on
 * every served request, and a truncated or hand-edited one must degrade to
 * "nothing recorded" rather than take the card down. Entries that carry no
 * usable counter are dropped rather than kept as zero rows, so the card's list
 * of "what used this model today" stays honest.
 *
 * Two shapes are accepted. `{version, days: [...]}` is what this build writes.
 * `{version, date, accounts}` is a single-day document from an earlier build;
 * it is read as one day so an upgrade does not throw away today's counts.
 * Both are normalized to the same list, sorted oldest-first and de-duplicated
 * by date (later entries win, which matters only for a hand-edited file).
 */
export function normalizeLedger(raw: unknown): UsageLedger {
  if (typeof raw !== 'object' || raw === null) return emptyLedger()
  const document = raw as Record<string, unknown>

  const parsed: UsageDay[] = []
  const legacyDate = document['date']
  if (typeof legacyDate === 'string' && legacyDate !== '') {
    parsed.push({ date: legacyDate, accounts: parseAccounts(document['accounts']) })
  }
  const daysRaw = document['days']
  if (Array.isArray(daysRaw)) {
    for (const entry of daysRaw) {
      if (typeof entry !== 'object' || entry === null) continue
      const day = entry as Record<string, unknown>
      const date = day['date']
      if (typeof date !== 'string' || date === '') continue
      parsed.push({ date, accounts: parseAccounts(day['accounts']) })
    }
  }
  // A document holding no usable day at all still reads as a ledger — one empty
  // day — so every reader can assume `days[0]` exists. The alternative is a
  // document that answers `undefined` to every lookup.
  if (parsed.length === 0) return emptyLedger()
  return { days: sortDays(dedupeDays(parsed)) }
}

/** Drop repeated dates, keeping the LAST occurrence. */
function dedupeDays(days: readonly UsageDay[]): UsageDay[] {
  const byDate = new Map<string, UsageDay>()
  for (const day of days) byDate.set(day.date, day)
  return [...byDate.values()]
}

/** Oldest first. `YYYY-MM-DD` sorts lexicographically in date order. */
function sortDays(days: readonly UsageDay[]): UsageDay[] {
  return [...days].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Keep only the most recent `retention` days, dropping anything older.
 *
 * Applied on every write, which is what bounds the file: the alternative is a
 * scheduled cleanup, which a host that is restarted often would never reach.
 */
export function retainRecentDays(
  days: readonly UsageDay[],
  retention: number = USAGE_RETENTION_DAYS,
): UsageDay[] {
  const sorted = sortDays(dedupeDays(days))
  if (retention <= 0) return []
  return sorted.slice(Math.max(0, sorted.length - retention))
}

/**
 * Read the ledger, tolerating every "no ledger yet" shape.
 *
 * A missing file, an unreadable one, or invalid JSON all mean the same thing —
 * nothing recorded — so none of them throws. Days are NOT filtered by date
 * here: history is the point, and a ledger whose newest day is older than today
 * simply has nothing for today (which the readers handle). The retention window
 * is applied on write.
 */
export async function readUsageLedger(path: string = usageLedgerPath()): Promise<UsageLedger> {
  try {
    return normalizeLedger(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return emptyLedger()
  }
}

/** Synchronous read, for startup. See {@link readUsageLedger} for the rules. */
export function readUsageLedgerSync(path: string = usageLedgerPath()): UsageLedger {
  try {
    return normalizeLedger(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return emptyLedger()
  }
}

/**
 * One usage report, as measured while a stream is served.
 *
 * `promptTokens` / `completionTokens` are undefined when the upstream sent no
 * usage frame. Callers must pass them through as absent rather than as 0:
 * {@link recordUsage} counts `reportedRequests` from exactly that distinction,
 * and the card uses it to say whether a token figure is measured or unknown.
 */
export interface UsageReport {
  accountId: string
  modelId: string | undefined
  promptTokens?: number
  completionTokens?: number
  /** Instant the count belongs to; defaults to now. */
  at?: Date
}

/** Model id recorded when a request named no model. */
export const UNKNOWN_MODEL_ID = '(unknown)'

/** The day holding `date`, or a fresh empty one. */
function dayIn(ledger: UsageLedger, date: string): UsageDay {
  return ledger.days.find(day => day.date === date) ?? emptyDay(date)
}

/**
 * Fold one report into a ledger, returning a NEW ledger.
 *
 * Pure on purpose: the caller owns persistence, so the counting rule (including
 * the day boundary, retention and the unreported-token distinction) is testable
 * without touching the filesystem or a clock.
 *
 * A report for a day the ledger does not hold appends that day, which is what
 * carries the ledger across midnight in a long-running process: without it,
 * every request after midnight would keep adding to yesterday's row and the
 * card would show a day that has already ended.
 */
export function recordUsage(
  ledger: UsageLedger,
  report: UsageReport,
  day: string = localDayKey(report.at ?? new Date()),
): UsageLedger {
  const current = dayIn(ledger, day)
  const modelId = report.modelId === undefined || report.modelId === '' ? UNKNOWN_MODEL_ID : report.modelId
  const accounts = { ...current.accounts }
  const models = { ...accounts[report.accountId] }
  const existing = models[modelId]
  const promptTokens = toCount(report.promptTokens)
  const completionTokens = toCount(report.completionTokens)
  // A frame with no prompt AND no completion tokens is not a usage report; it
  // must not inflate `reportedRequests`, or the card would claim a measured
  // token count for a stream that never carried one.
  const reported = promptTokens > 0 || completionTokens > 0
  models[modelId] = {
    requests: (existing?.requests ?? 0) + 1,
    promptTokens: (existing?.promptTokens ?? 0) + promptTokens,
    completionTokens: (existing?.completionTokens ?? 0) + completionTokens,
    reportedRequests: (existing?.reportedRequests ?? 0) + (reported ? 1 : 0),
    lastUsedAt: (report.at ?? new Date()).toISOString(),
  }
  accounts[report.accountId] = models
  const others = ledger.days.filter(entry => entry.date !== day)
  return { days: retainRecentDays([...others, { date: day, accounts }]) }
}

/**
 * Replace the ledger, atomically.
 *
 * Written to a sibling temp file and renamed over the target, so a crash or a
 * concurrent reader never observes a half-written document: a truncated ledger
 * reads as "no usage", which would silently under-report a model that is
 * already near its daily allowance — the one case the feature exists to catch.
 */
export async function writeUsageLedger(
  ledger: UsageLedger,
  path: string = usageLedgerPath(),
): Promise<void> {
  const kept = retainRecentDays(ledger.days)
  const payload = JSON.stringify({ version: 2, days: kept }, null, 2)
  // Create the directory the TARGET lives in, not the default one: tests pass
  // an explicit path and creating the wrong directory would fail with ENOENT.
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${payload}\n`, 'utf8')
  await rename(temp, path)
}

/** One account's row for one model, as the card renders it. */
export interface UsageRow {
  modelId: string
  requests: number
  /** Total tokens, prompt + completion. */
  tokens: number
  /** Whether the token figure came from the upstream (false = not reported). */
  tokensReported: boolean
  lastUsedAt?: string
}

/** One account's day, summed over every model. See {@link usageTotalsFor}. */
export interface UsageTotals {
  requests: number
  tokens: number
  tokensReported: boolean
}

/**
 * One account's usage on one day, newest-used model first.
 *
 * Sorted by recency rather than by model id: the model a user is actually
 * working with is the one they just used, and an alphabetical list buries it.
 */
export function usageRowsFor(ledger: UsageLedger, accountId: string, date: string = localDayKey()): UsageRow[] {
  const models = ledger.days.find(day => day.date === date)?.accounts[accountId]
  if (models === undefined) return []
  const rows = Object.entries(models).map(([modelId, counters]): UsageRow => ({
    modelId,
    requests: counters.requests,
    tokens: counters.promptTokens + counters.completionTokens,
    tokensReported: counters.reportedRequests > 0,
    ...counters.lastUsedAt === '' ? {} : { lastUsedAt: counters.lastUsedAt },
  }))
  rows.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
  return rows
}

/** Every account's usage today, keyed by account id. */
export function usageByAccount(ledger: UsageLedger, date: string = localDayKey()): Record<string, UsageRow[]> {
  const out: Record<string, UsageRow[]> = {}
  const day = ledger.days.find(entry => entry.date === date)
  if (day === undefined) return out
  for (const accountId of Object.keys(day.accounts)) {
    const rows = usageRowsFor(ledger, accountId, date)
    if (rows.length > 0) out[accountId] = rows
  }
  return out
}

/**
 * One account's usage on one day, summed over every model.
 *
 * `tokens` adds only the models that reported a usage frame, and
 * `tokensReported` says whether any did: a gateway that sends no usage frame
 * yields a request count with no token claim rather than a token figure of 0.
 */
export function usageTotalsFor(ledger: UsageLedger, accountId: string, date: string = localDayKey()): UsageTotals | undefined {
  const rows = usageRowsFor(ledger, accountId, date)
  if (rows.length === 0) return undefined
  let requests = 0
  let tokens = 0
  let tokensReported = false
  for (const row of rows) {
    requests += row.requests
    if (row.tokensReported) {
      tokens += row.tokens
      tokensReported = true
    }
  }
  return { requests, tokens, tokensReported }
}

/** One row of the usage panel: a slice of the window, with its counters. */
export interface UsageSlice {
  /** Date, model id, or account id — whichever dimension the slice is on. */
  key: string
  requests: number
  tokens: number
  /** False when no request in this slice carried a token count. */
  tokensReported: boolean
}

/** Usage over a window, broken down along each dimension the card shows. */
export interface UsageSummary {
  /** First and last day covered, `YYYY-MM-DD`. */
  from: string
  to: string
  /** Days actually holding data, gaps included as zero rows for the chart. */
  days: readonly UsageSlice[]
  models: readonly UsageSlice[]
  accounts: readonly UsageSlice[]
  /** Split by gateway, keyed `cn` / `global` (an unmapped account lands in `cn`). */
  regions: readonly UsageSlice[]
  totals: UsageTotals
}

/** A running per-key tally, folded into `UsageSlice` at the end. */
interface Tally {
  requests: number
  tokens: number
  reported: boolean
}

/**
 * Sum a window of days into the breakdowns the usage panel renders.
 *
 * `windowDays` bounds the range: either the last N calendar days ({@link
 * recentDayKeys}) or a shorter explicit list. Days with no data still appear in
 * `days`, because the chart's whole job is to show the gap — dropping them
 * would silently compress a quiet weekend into "no gap at all".
 *
 * Tokens are summed only from requests that carried a usage frame, and a slice
 * is `tokensReported: false` when none did, so a gateway that reports nothing
 * shows a request count rather than a token figure of zero.
 *
 * `accountRegion` maps account id → region, which is what makes the
 * per-region split possible: the ledger is keyed by account only, and the
 * region lives on the credential.
 */
export function usageSummary(
  ledger: UsageLedger,
  options: { windowDays?: readonly string[]; accountRegion?: (accountId: string) => string } = {},
): UsageSummary {
  const window = options.windowDays ?? recentDayKeys()
  const held = new Map(ledger.days.map(day => [day.date, day]))
  const days: UsageSlice[] = []
  const models = new Map<string, Tally>()
  const accounts = new Map<string, Tally>()
  const regions = new Map<string, Tally>()
  const totals: Tally = { requests: 0, tokens: 0, reported: false }

  for (const date of window) {
    const day = held.get(date)
    let dayRequests = 0
    let dayTokens = 0
    let dayReported = false
    for (const [accountId, byModel] of Object.entries(day?.accounts ?? {})) {
      const region = options.accountRegion?.(accountId) ?? 'cn'
      for (const [modelId, counters] of Object.entries(byModel)) {
        const tokens = counters.promptTokens + counters.completionTokens
        const reported = counters.reportedRequests > 0
        dayRequests += counters.requests
        if (reported) {
          dayTokens += tokens
          dayReported = true
        }
        bump(models, modelId, counters.requests, tokens, reported)
        bump(accounts, accountId, counters.requests, tokens, reported)
        bump(regions, region, counters.requests, tokens, reported)
        totals.requests += counters.requests
        if (reported) {
          totals.tokens += tokens
          totals.reported = true
        }
      }
    }
    days.push({ key: date, requests: dayRequests, tokens: dayTokens, tokensReported: dayReported })
  }

  return {
    from: window[0] ?? '',
    to: window[window.length - 1] ?? '',
    days,
    models: finish(models),
    accounts: finish(accounts),
    regions: finish(regions),
    totals: { requests: totals.requests, tokens: totals.tokens, tokensReported: totals.reported },
  }
}

function bump(map: Map<string, Tally>, key: string, requests: number, tokens: number, reported: boolean): void {
  const existing = map.get(key) ?? { requests: 0, tokens: 0, reported: false }
  existing.requests += requests
  if (reported) {
    existing.tokens += tokens
    existing.reported = true
  }
  map.set(key, existing)
}

/** Heaviest first: the busiest model or account is what the user is looking for. */
function finish(map: Map<string, Tally>): UsageSlice[] {
  return [...map.entries()]
    .map(([key, tally]): UsageSlice => ({
      key,
      requests: tally.requests,
      tokens: tally.tokens,
      tokensReported: tally.reported,
    }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
}
