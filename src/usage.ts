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
 * On disk the ledger is one JSON document holding the CURRENT day only. Keeping
 * history would grow without bound for a number the card only ever reads as
 * "today", and a stale day is discarded on load rather than relabelled as
 * today — the same rule the automation earnings ledger uses.
 *
 * @module dsh-workbuddy-xdpool/usage
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginDataDir } from './ignored.ts'

/** File holding the daily usage ledger, inside `pluginDataDir`. */
export const USAGE_FILE_NAME = 'usage.json'

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
 * The whole ledger: one day, every account, every model.
 *
 * `accounts` maps account id → model id → counters. The nesting is nested
 * rather than a flat `accountId/modelId` key because both halves of the key are
 * opaque upstream strings that can contain any character; a separator-based key
 * would collide on a model id that happens to contain the separator.
 */
export interface UsageLedger {
  /** Local day the counters belong to, `YYYY-MM-DD`. */
  date: string
  accounts: Record<string, Record<string, UsageCounters>>
}

/** `YYYY-MM-DD` in local time, matching how every other day key is built. */
export function localDayKey(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** An empty ledger for one day. */
export function emptyLedger(date: string = localDayKey()): UsageLedger {
  return { date, accounts: {} }
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Normalize a decoded document into a ledger.
 *
 * Tolerant on purpose, exactly like the ignore list: this file is written on
 * every served request, and a truncated or hand-edited one must degrade to
 * "nothing recorded" rather than take the card down. Entries that carry no
 * usable counter are dropped rather than kept as zero rows, so the card's list
 * of "what used this model today" stays honest.
 */
export function normalizeLedger(raw: unknown): UsageLedger {
  if (typeof raw !== 'object' || raw === null) return emptyLedger()
  const document = raw as Record<string, unknown>
  const date = typeof document['date'] === 'string' ? document['date'] : ''
  if (date === '') return emptyLedger()
  const accountsRaw = document['accounts']
  if (typeof accountsRaw !== 'object' || accountsRaw === null) return emptyLedger(date)
  const accounts: Record<string, Record<string, UsageCounters>> = {}
  for (const [accountId, modelsRaw] of Object.entries(accountsRaw as Record<string, unknown>)) {
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
  return { date, accounts }
}

/**
 * Read the ledger, tolerating every "no ledger yet" shape.
 *
 * A missing file, an unreadable one, or invalid JSON all mean the same thing —
 * nothing recorded — so none of them throws. A ledger left over from an earlier
 * day is discarded rather than counted as today: the counters are daily by
 * definition, and carrying them forward would make "today" mean "ever".
 */
export async function readUsageLedger(path: string = usageLedgerPath()): Promise<UsageLedger> {
  try {
    const ledger = normalizeLedger(JSON.parse(await readFile(path, 'utf8')) as unknown)
    return ledger.date === localDayKey() ? ledger : emptyLedger()
  } catch {
    return emptyLedger()
  }
}

/** Synchronous read, for startup. See {@link readUsageLedger} for the rules. */
export function readUsageLedgerSync(path: string = usageLedgerPath()): UsageLedger {
  try {
    const ledger = normalizeLedger(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return ledger.date === localDayKey() ? ledger : emptyLedger()
  } catch {
    return emptyLedger()
  }
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
  const payload = JSON.stringify({ version: 1, ...ledger }, null, 2)
  // Create the directory the TARGET lives in, not the default one: tests pass
  // an explicit path and creating the wrong directory would fail with ENOENT.
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${payload}\n`, 'utf8')
  await rename(temp, path)
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

/**
 * Fold one report into a ledger, returning a NEW ledger.
 *
 * Pure on purpose: the caller owns persistence and roll-over, so the counting
 * rule (including the day boundary and the unreported-token distinction) is
 * testable without touching the filesystem or a clock.
 *
 * A report for a different day than the ledger's resets the ledger first. That
 * matters because the process outlives midnight: a long-running host would
 * otherwise keep adding to yesterday's rows and the card would show a day that
 * has already ended.
 */
export function recordUsage(
  ledger: UsageLedger,
  report: UsageReport,
  day: string = localDayKey(report.at ?? new Date()),
): UsageLedger {
  const base = ledger.date === day ? ledger : emptyLedger(day)
  const modelId = report.modelId === undefined || report.modelId === '' ? UNKNOWN_MODEL_ID : report.modelId
  const accounts = { ...base.accounts }
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
  return { date: base.date, accounts }
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

/**
 * One account's usage today, newest-used model first.
 *
 * Sorted by recency rather than by model id: the model a user is actually
 * working with is the one they just used, and an alphabetical list buries it.
 */
export function usageRowsFor(ledger: UsageLedger, accountId: string): UsageRow[] {
  const models = ledger.accounts[accountId]
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
export function usageByAccount(ledger: UsageLedger): Record<string, UsageRow[]> {
  const out: Record<string, UsageRow[]> = {}
  for (const accountId of Object.keys(ledger.accounts)) {
    const rows = usageRowsFor(ledger, accountId)
    if (rows.length > 0) out[accountId] = rows
  }
  return out
}
