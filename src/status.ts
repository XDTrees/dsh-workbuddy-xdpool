/**
 * Read-only status assembly shared by the CLI and the settings card.
 *
 * Credits are queried per account; a failing query degrades to an error field
 * rather than failing the whole document, because billing is an auxiliary
 * concern next to actually serving models.
 *
 * @module dsh-workbuddy-xdpool/status
 */

import type { WorkBuddyAccount, WorkBuddyAccountPool } from './accounts.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import type { WorkBuddyCredits, WorkBuddyUpstreamClient } from './upstream.ts'

/** One account's status row. */
export interface AccountStatus {
  id: string
  label: string
  nickname?: string
  domain: string
  /** ISO timestamp when the access token expires. */
  expiresAt?: string
  /** Account-wide cooldown (every model blocked). */
  cooling: boolean
  cooldownUntil?: string
  /** Per-model cooldowns active right now (modelId → ISO until); the account
   *  itself is not `cooling` while only some models are limited. */
  modelCooldowns?: readonly { modelId: string; until: string }[]
  rateLimitHits: number
  /** Read-only aggregated credit summary for the account. */
  credits?: WorkBuddyCredits
  creditsError?: string
  sourcePath: string
}

/** Whole-plugin status document. */
export interface WorkBuddyStatus {
  ok: boolean
  accounts: AccountStatus[]
  activeAccountId?: string
  cooling: number
  models: { id: string; name: string; multiplier?: number; tags?: readonly string[] }[]
  shim: { running: boolean; baseUrl?: string }
}

export interface StatusOptions {
  pool: WorkBuddyAccountPool
  catalog: WorkBuddyCatalog
  client: WorkBuddyUpstreamClient
  shim?: { running: boolean; baseUrl?: string }
  /** Query credits per account. Off for cheap diagnostics runs. */
  includeCredits?: boolean
}

/** Build the status document. Never throws. */
export async function buildStatus(options: StatusOptions): Promise<WorkBuddyStatus> {
  const { pool, catalog, client } = options
  const accounts = pool.list()
  const now = Date.now()

  const rows: AccountStatus[] = []
  for (const account of accounts) {
    const modelCooldowns = Object.entries(account.modelCooldowns)
      .filter(([, until]) => until > now)
      .sort((a, b) => a[1] - b[1])
      .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }))
    const row: AccountStatus = {
      id: account.id,
      label: account.label,
      ...account.credential.nickname === undefined ? {} : { nickname: account.credential.nickname },
      domain: account.credential.domain,
      ...account.credential.expiresAtMs === 0
        ? {}
        : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
      cooling: account.cooldownUntilMs > now,
      ...account.cooldownUntilMs > now
        ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() }
        : {},
      ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
      rateLimitHits: account.rateLimitHits,
      sourcePath: account.credential.sourcePath,
    }

    if (options.includeCredits === true && !row.cooling) {
      try {
        Object.assign(row, { credits: await client.fetchCredits(account.credential) })
      } catch (error: unknown) {
        Object.assign(row, { creditsError: String(error).slice(0, 200) })
      }
    }
    rows.push(row)
  }

  const cooling = rows.filter(row => row.cooling).length
  const firstUsable = accounts.find(account => account.cooldownUntilMs <= now)

  return {
    ok: accounts.length > 0 && cooling < accounts.length,
    accounts: rows,
    ...firstUsable === undefined ? {} : { activeAccountId: firstUsable.id },
    cooling,
    models: catalog.current().map(model => ({
      id: model.id,
      name: model.name,
      ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
      ...model.tags === undefined ? {} : { tags: model.tags },
    })),
    shim: options.shim ?? { running: false },
  }
}

/** Format the status document for a terminal. */
export function formatStatus(status: WorkBuddyStatus): string {
  const lines: string[] = []
  lines.push(`WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling`)
  lines.push(`Shim: ${status.shim.running ? 'running' : 'stopped'}${status.shim.baseUrl === undefined ? '' : ` at ${status.shim.baseUrl}`}`)
  lines.push('')
  if (status.accounts.length === 0) {
    lines.push('No WorkBuddy credential found. Sign in on the WorkBuddy desktop app,')
    lines.push('then run: dsh plugin --profile desktop exec dsh-workbuddy-xdpool import <key>')
    return lines.join('\n')
  }
  for (const account of status.accounts) {
    const flag = account.cooling ? '⏸ ' : '▶ '
    const active = account.id === status.activeAccountId ? ' (next up)' : ''
    lines.push(`${flag}${account.label}${active}`)
    lines.push(`    uid/uin   : ${account.id}  [${account.domain || 'cn'}]`)
    if (account.expiresAt !== undefined) lines.push(`    expires   : ${account.expiresAt}`)
    if (account.credits !== undefined) {
      const { total } = account.credits
      const parts: string[] = []
      if (total !== undefined) parts.push(`total ${total}`)
      lines.push(`    credits   : ${parts.join(' | ') || 'n/a'}`)
    }
    if (account.creditsError !== undefined) lines.push(`    credits   : query failed — ${account.creditsError}`)
    if (account.cooling && account.cooldownUntil !== undefined) {
      lines.push(`    cooldown  : until ${account.cooldownUntil} (hits ${account.rateLimitHits})`)
    }
    if (account.modelCooldowns !== undefined && account.modelCooldowns.length > 0) {
      for (const mc of account.modelCooldowns) {
        lines.push(`    model-cool: ${mc.modelId} until ${mc.until}`)
      }
    }
    lines.push(`    source    : ${account.sourcePath}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Format the per-model credit multipliers. */
export function formatRates(status: WorkBuddyStatus): string {
  const lines = ['Model credit multipliers:']
  for (const model of status.models) {
    const rate = model.multiplier === undefined ? 'x?' : `x${model.multiplier.toFixed(2)}`
    lines.push(`  ${model.name.padEnd(20)} ${rate}`)
  }
  return lines.join('\n')
}

export type { WorkBuddyAccount }
