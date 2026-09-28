/**
 * The permanent ignore list: accounts the user has thrown out of the pool.
 *
 * Distinct from `disabledAccountIds`, which is a ROTATION preference. A disabled
 * account stays on the card, can be switched back on, and its credential keeps
 * being read on every scan. Ignoring is a statement about the ACCOUNT — "this
 * one is not mine any more" — so an ignored account is skipped BEFORE its
 * credential is decrypted, never appears among the pool's accounts, and does not
 * come back when the desktop app writes a fresh `.info` file for it.
 *
 * It lives in a plugin-owned file rather than in the settings document for one
 * practical reason: the CLI has no settings service. `dsh-workbuddy-xdpool
 * ignore <id>` runs without a host, so a settings-only list could be written by
 * the card and never by the CLI. One file, read by both halves, keeps the two
 * views of "which accounts are ignored" identical by construction.
 *
 * @module dsh-workbuddy-xdpool/ignored
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PoolWebIgnoredAccount } from './status-paths.ts'

/** Directory holding this plugin's own state (imported snapshots, ignore list). */
export const PLUGIN_DATA_DIR_NAME = '.workbuddy-xdpool'

/** File holding the permanent ignore list, inside {@link pluginDataDir}. */
export const IGNORED_FILE_NAME = 'ignored.json'

/** One ignored account, as stored on disk and shown on the card. */
export type IgnoredAccount = PoolWebIgnoredAccount

/**
 * The DSH home directory, honouring the same override the host uses.
 *
 * Shared by the CLI and the host so both halves resolve the same file: an
 * `ignore` written from the terminal has to be visible to the running plugin,
 * which is only true if they agree on where "home" is.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** This plugin's own state directory. */
export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_DATA_DIR_NAME)
}

/** Absolute path of the ignore list. */
export function ignoredIdsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), IGNORED_FILE_NAME)
}

/**
 * Normalize whatever the file holds into a clean list.
 *
 * Tolerant on purpose: this file is hand-editable and a malformed entry must not
 * take the pool down. An entry without a usable id is dropped; a missing label
 * falls back to the id so the card always has something to print.
 */
function normalize(raw: unknown): IgnoredAccount[] {
  if (typeof raw !== 'object' || raw === null) return []
  const entries = (raw as { accounts?: unknown }).accounts
  if (!Array.isArray(entries)) return []
  const out: IgnoredAccount[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const label = typeof record['label'] === 'string' && record['label'].trim() !== ''
      ? record['label']
      : id
    const ignoredAt = typeof record['ignoredAt'] === 'string' ? record['ignoredAt'] : ''
    out.push({ id, label, ignoredAt })
  }
  return out
}

/**
 * Read the ignore list, tolerating every "no list yet" shape.
 *
 * A missing file, unreadable file, or invalid JSON all mean the same thing to
 * the caller — nothing is ignored — so none of them throws. The pool must be
 * able to start on a machine that has never ignored anything.
 */
export async function readIgnoredAccounts(path: string = ignoredIdsPath()): Promise<IgnoredAccount[]> {
  try {
    return normalize(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return []
  }
}

/**
 * Synchronous read, for startup.
 *
 * The host applies the ignore list from inside `apply()`, which is synchronous,
 * and doing it there removes a startup race: an async load could resolve AFTER
 * the first account scan, which would let an ignored account slip into the pool
 * once per boot. The file is a few hundred bytes, so a blocking read at startup
 * costs nothing measurable.
 */
export function readIgnoredAccountsSync(path: string = ignoredIdsPath()): IgnoredAccount[] {
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return []
  }
}

/**
 * Replace the ignore list, atomically.
 *
 * Written to a sibling temp file and renamed over the target so a crash (or a
 * concurrent reader) can never observe a half-written document — the ignore
 * list is the only thing standing between a dead account and the rotation, and
 * a truncated file reads as "nothing is ignored", which would quietly put every
 * discarded account back in the pool.
 */
export async function writeIgnoredAccounts(
  accounts: readonly IgnoredAccount[],
  path: string = ignoredIdsPath(),
): Promise<void> {
  const payload = JSON.stringify({ version: 1, accounts }, null, 2)
  // Create the directory the TARGET lives in, not the default one: tests (and
  // any future caller) pass an explicit path, and creating the wrong directory
  // would leave the write to fail with ENOENT.
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${payload}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * Add one account to the ignore list, preserving the rest.
 *
 * A read-modify-write rather than a wholesale replace: the card and the CLI can
 * both be open, and each request names exactly one account, so re-writing the
 * whole list from a stale view would drop the other side's edits.
 */
export async function ignoreAccount(
  account: { id: string; label?: string },
  path: string = ignoredIdsPath(),
): Promise<IgnoredAccount[]> {
  const current = await readIgnoredAccounts(path)
  if (current.some(entry => entry.id === account.id)) return current
  const next = [
    ...current,
    { id: account.id, label: account.label ?? account.id, ignoredAt: new Date().toISOString() },
  ]
  await writeIgnoredAccounts(next, path)
  return next
}

/** Drop one account from the ignore list. Returns the resulting list. */
export async function unignoreAccount(
  accountId: string,
  path: string = ignoredIdsPath(),
): Promise<IgnoredAccount[]> {
  const current = await readIgnoredAccounts(path)
  const next = current.filter(entry => entry.id !== accountId)
  if (next.length !== current.length) await writeIgnoredAccounts(next, path)
  return next
}
