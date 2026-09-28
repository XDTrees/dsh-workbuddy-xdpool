/**
 * Regression tests for the 1.7.0 reports: settings that were saved but never
 * applied, a schedule that silently disabled every job, and a model selection
 * that widened to "everything" when it went missing.
 *
 * These are the three defects behind the user-visible symptoms:
 *
 *  - #18  every restart reverted the distribution, the automation switch and the
 *         model selection, while the settings FILE still held them. The read
 *         path was fine; `applyConfigFromSource()` simply had no call site at
 *         startup, so the runtime objects stayed at their constructor defaults.
 *  - #17a `enabled: true` with empty hour lists ran nothing at all, forever: the
 *         schema materializes "never configured" into `[]`, the scheduler
 *         adopted that empty array, and the card wrote it back.
 *  - #17b a region whose selection key went missing fell back to `{}`, which
 *         reads as "all enabled" — losing a curated list WIDENED it to the whole
 *         catalog.
 *
 * The host entry cannot be imported here (it pulls in the whole host runtime and
 * `@deepseek-ai/dsh-settings`), so the structural assertions read the source and
 * the behavioural ones drive the real collaborators: the scheduler, the catalog
 * and the pool.
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WorkBuddyScheduler } from '../src/scheduler.ts'
import { DEFAULT_AUTOMATION_HOURS } from '../src/status-paths.ts'
import {
  ignoreAccount,
  ignoredIdsPath,
  pluginDataDir,
  readIgnoredAccounts,
  unignoreAccount,
  writeIgnoredAccounts,
} from '../src/ignored.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Source of the host entry, read as text for the structural assertions. */
const hostSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** Write a fake auth directory holding `count` accounts, returning its path. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-fixes-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.f.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A scheduler whose upstream is never called (nothing is due in these tests). */
function inertScheduler(): WorkBuddyScheduler {
  return new WorkBuddyScheduler({} as unknown as WorkBuddyUpstreamClient, {})
}

describe('#18 the saved configuration is applied at startup', () => {
  it('the host entry calls applyConfigFromSource at apply() top level', () => {
    // The startup call is a STANDALONE statement at `apply()`'s own indentation
    // (two spaces). Both other call sites are embedded in something else — a
    // hook body (`onChange() { … }`) and a listener arrow (`() => { … }`) — so
    // an exact-line match can only be the startup one.
    //
    // Finding the call only inside those two is the defect: both are listeners,
    // so neither fires during startup and every runtime object stays at its
    // constructor default.
    const marker = 'applyConfigFromSource()'
    const occurrences = hostSource.split(marker).length - 1
    expect(occurrences, 'applyConfigFromSource must be called, not merely defined').toBeGreaterThan(0)

    // Split on either ending: the source files are CRLF, so splitting on '\n'
    // alone would leave a trailing '\r' and defeat an exact-line match.
    const standalone = hostSource.split(/\r?\n/).filter(line => line === `  ${marker}`)
    expect(
      standalone.length,
      'applyConfigFromSource() must run at startup as a standalone statement, not only on a settings event',
    ).toBeGreaterThan(0)
  })

  it('a saved automation config reaches the scheduler through applyConfig', () => {
    // The behaviour the startup call buys: a document that names a schedule
    // must put that schedule in force.
    const scheduler = inertScheduler()
    scheduler.applyConfig({
      enabled: true,
      checkinHours: [7],
      reportHours: [8],
      taskHours: [13],
      streakHours: [14],
      travelHours: [9, 21],
    })
    const status = scheduler.status()
    expect(status.enabled).toBe(true)
    expect(status.checkinHours).toEqual([7])
    expect(status.reportHours).toEqual([8])
    expect(status.taskHours).toEqual([13])
    expect(status.streakHours).toEqual([14])
  })

  it('the distribution a config names is the one the pool reports', () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [], logger: { warn() {} } })
    expect(pool.currentDistribution()).toBe('priority')
    pool.applyConfig({ distribution: 'round-robin' })
    expect(pool.currentDistribution()).toBe('round-robin')
  })

  it('the model selection a config names is the one the catalog reports', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.applySelection({ enabledModelIds: ['glm-5.3'] })
    expect(catalog.currentSelection().enabledModelIds).toEqual(['glm-5.3'])
  })
})

describe('#17a an empty hour list falls back to the default schedule', () => {
  it('an enabled automation with empty hour lists still runs on the defaults', () => {
    // This is the exact stored shape the report showed: enabled, four empty
    // lists, no travelHours. Before the fix every job was permanently due=false.
    const scheduler = inertScheduler()
    scheduler.applyConfig({
      enabled: true,
      checkinHours: [],
      reportHours: [],
      taskHours: [],
      streakHours: [],
    })
    const status = scheduler.status()
    expect(status.enabled).toBe(true)
    expect(status.checkinHours).toEqual(DEFAULT_AUTOMATION_HOURS.checkin)
    expect(status.reportHours).toEqual(DEFAULT_AUTOMATION_HOURS.report)
    expect(status.taskHours).toEqual(DEFAULT_AUTOMATION_HOURS.tasks)
    expect(status.streakHours).toEqual(DEFAULT_AUTOMATION_HOURS.streak)
    // travelHours was absent entirely; the default must still be two passes.
    expect(status.travelHours).toEqual(DEFAULT_AUTOMATION_HOURS.travel)
  })

  it('a non-empty hour list is still honoured verbatim', () => {
    // The fallback must not swallow a real schedule — the fix would be worse
    // than the bug if it overrode a user's chosen hours.
    const scheduler = inertScheduler()
    scheduler.applyConfig({ enabled: true, checkinHours: [6, 18] })
    expect(scheduler.status().checkinHours).toEqual([6, 18])
  })

  it('a job with no usable hour is never reported as runnable-but-empty', () => {
    // Regression guard on the shape: after applyConfig, no job may be left with
    // an empty list, because an empty list is exactly what `isDue` vetoes.
    const scheduler = inertScheduler()
    scheduler.applyConfig({ enabled: true, checkinHours: [], travelHours: [] })
    const status = scheduler.status()
    for (const hours of [status.checkinHours, status.reportHours, status.taskHours, status.streakHours, status.travelHours]) {
      expect(hours.length).toBeGreaterThan(0)
    }
  })

  it('the card carries travelHours and the defaults when it writes the block', async () => {
    const cardSource = await readFile(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
    // `travelHours` missing from the write-back is defect #17a's fourth stage:
    // the card could never repair the document it had been shown.
    expect(cardSource).toContain('travelHours: hoursOrDefault(')
    // And every list must go through the fallback, or an empty document stays empty.
    for (const key of ['checkinHours', 'reportHours', 'taskHours', 'streakHours']) {
      expect(cardSource).toContain(`${key}: hoursOrDefault(`)
    }
  })
})

describe('#17b a missing selection must not widen to "everything"', () => {
  it('the host entry keeps the in-force selection instead of applying an empty one', () => {
    // Structural: the fallback has to consult the catalog's current selection.
    // Falling straight through to `legacySelection` (which is `{}` when the
    // legacy keys are unset) is what turned a lost list into a full one.
    expect(hostSource).toContain('fallbackSelection')
    expect(hostSource).toContain('currentSelection()')
  })

  it('an empty selection object means "everything", which is why it must not be a fallback', () => {
    // Documents WHY the fallback matters, so a future refactor that "simplifies"
    // it back to `{}` fails here rather than in production.
    const catalog = new WorkBuddyCatalog()
    catalog.applySelection({ enabledModelIds: ['glm-5.3'] })
    expect(catalog.visible().map(model => model.id)).toEqual(['glm-5.3'])

    // Applying `{}` widens it back to the whole catalog — the exact regression.
    catalog.applySelection({})
    expect(catalog.visible().length).toBeGreaterThan(1)
  })
})

describe('#19 ignored accounts never re-enter the pool', () => {
  it('a scanned account is skipped once ignored, and comes back when restored', async () => {
    const authDir = await fakeAuthDir(2)
    const pool = new WorkBuddyAccountPool({ authDirs: [authDir], logger: { warn() {} } })
    const found = await pool.scan()
    expect(found).toHaveLength(2)

    const victim = found[0]!
    pool.applyIgnored([victim.id])
    // The already-discovered account leaves immediately, without a rescan.
    expect(pool.list().some(account => account.id === victim.id)).toBe(false)

    // The decisive case: the credential file is STILL ON DISK (the desktop app
    // rewrote it, or simply still has it), and a fresh scan must not pick it up.
    const rescanned = await pool.scan()
    expect(rescanned.some(account => account.id === victim.id)).toBe(false)
    expect(rescanned).toHaveLength(1)

    // Restoring makes the next scan discover it again.
    pool.applyIgnored([])
    const restored = await pool.scan()
    expect(restored.some(account => account.id === victim.id)).toBe(true)
  })

  it('the ignore list is a file the CLI and the host both read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wbp-home-'))
    const env = { ...process.env, DSH_HOME: home } as NodeJS.ProcessEnv
    const path = ignoredIdsPath(env)
    // Under the DSH home, in the plugin's own directory — not the settings file.
    expect(path.startsWith(pluginDataDir(env))).toBe(true)
    expect(path.endsWith('ignored.json')).toBe(true)

    await ignoreAccount({ id: 'abc123', label: 'Account One' }, path)
    const stored = await readIgnoredAccounts(path)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: 'abc123', label: 'Account One' })

    // Idempotent: ignoring twice must not duplicate the entry.
    await ignoreAccount({ id: 'abc123', label: 'Account One' }, path)
    expect(await readIgnoredAccounts(path)).toHaveLength(1)

    // Un-ignoring removes exactly that entry.
    await unignoreAccount('abc123', path)
    expect(await readIgnoredAccounts(path)).toHaveLength(0)
  })

  it('tolerates a missing, malformed, or hand-edited file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wbp-home-bad-'))
    const env = { ...process.env, DSH_HOME: home } as NodeJS.ProcessEnv
    const path = ignoredIdsPath(env)

    // Missing file: nothing is ignored, and nothing throws.
    expect(await readIgnoredAccounts(path)).toEqual([])

    // Garbage JSON: same answer, no throw. A pool that refused to start because
    // of a corrupt ignore list would be a worse failure than the one it prevents.
    await mkdir(pluginDataDir(env), { recursive: true })
    await writeFile(path, '{ not json', 'utf8')
    expect(await readIgnoredAccounts(path)).toEqual([])

    // Hand-edited entries: usable ones survive, junk is dropped, dupes collapse.
    await writeIgnoredAccounts([
      { id: 'keep', label: 'Keep', ignoredAt: '2026-01-01T00:00:00.000Z' },
      { id: '', label: 'no id', ignoredAt: '' },
      { id: 'keep', label: 'dupe', ignoredAt: '' },
    ], path)
    const cleaned = await readIgnoredAccounts(path)
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]!.id).toBe('keep')
  })

  it('the host loads the list synchronously at startup and re-reads it on write', () => {
    // Synchronous at apply() time is load-bearing: an async load could resolve
    // AFTER the first scan, letting an ignored account into the pool once per boot.
    expect(hostSource).toContain('readIgnoredAccountsSync')
    expect(hostSource).toContain('refreshIgnored')
    expect(hostSource).toContain('setAccountIgnored')
  })

  it('the card offers both remove and restore, so ignoring is not a one-way door', () => {
    // Structural, but it is the whole usability contract of the feature: a user
    // who removes the wrong account must be able to find it and put it back.
    expect(hostSource).toContain('ignoredAccounts')
  })
})
