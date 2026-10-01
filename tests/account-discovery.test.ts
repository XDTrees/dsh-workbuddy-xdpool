/**
 * Regression tests for "accounts vanish when switching sign-in".
 *
 * The reported symptom: four domestic accounts signed in via WorkBuddy Switch,
 * the card showed four, and after restarting DSH only two remained.
 *
 * Root cause found here: `readCredential` rethrew
 * `WorkBuddyEncryptedCredentialError`, and `scan()` had no per-file guard — so
 * ONE file the plugin could not open (an encrypted credential whose at-rest key
 * was unavailable, because the desktop app was not running or could not be
 * located) propagated out and discarded every account that HAD parsed fine.
 * An auth directory routinely blends plain files, encrypted files and files from
 * a desktop version this plugin cannot read, so the mix is normal, not an error.
 *
 * The fix has two halves, and both are asserted:
 *   1. a bad file is SKIPPED, never fatal to the scan;
 *   2. the skip is REPORTED, so "2 accounts" can be distinguished from
 *      "4 files, 2 unreadable" — a count that silently disagrees with disk is
 *      what made this look like deleted accounts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'

/** A plain-JSON credential, the shape older desktop builds write. */
function plainCredential(name: string): string {
  return JSON.stringify({
    auth: {
      accessToken: `token-${name}`,
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
  })
}

/**
 * A credential encrypted at rest, the shape 5.6.0+ writes.
 *
 * The envelope is deliberately invalid: the point is that the plugin cannot open
 * it, which is the situation that used to abort the whole scan.
 */
function encryptedCredential(name: string): string {
  return JSON.stringify({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'not-a-real-envelope' },
      refreshToken: { $wbEncrypted: 1, envelope: 'not-a-real-envelope' },
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
  })
}

function pool(dir: string): WorkBuddyAccountPool {
  return new WorkBuddyAccountPool({ authDirs: [dir], logger: { warn() {} } })
}

/** A directory with `good` readable accounts and `bad` unopenable ones. */
function mixedDir(good: number, bad: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-mixed-'))
  for (let i = 0; i < good; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.good${i}.info`), plainCredential(`good${i}`))
  }
  for (let i = 0; i < bad; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.bad${i}.info`), encryptedCredential(`bad${i}`))
  }
  return dir
}

/**
 * These cases touch the real at-rest key lookup, which — on a machine that HAS
 * the desktop app installed — can spend several seconds trying to reach it
 * before failing. That is the real behaviour under test (the file must be
 * skipped, not fatal), so the timeout is raised rather than stubbed out:
 * mocking the lookup would stop the test from covering the path that broke.
 *
 * The first case pays the cost; the rest are fast because the lookup result is
 * cached per process.
 */
const SLOW = 60_000

describe('one unopenable file must not empty the pool', () => {
  it('keeps every account that parsed fine', async () => {
    // 3 readable + 1 encrypted-and-unopenable: the scan must yield 3, not throw
    // and not return 0. This is the reported defect in miniature.
    const dir = mixedDir(3, 1)
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(3)
  }, SLOW)

  it('succeeds even when EVERY file is unopenable', async () => {
    // Degenerate case: no throw, an empty pool, and the skips reported.
    const dir = mixedDir(0, 2)
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(0)
    expect(p.skippedFilesInOrder()).toHaveLength(2)
  }, SLOW)

  it('reports the skipped files with the reason', async () => {
    const dir = mixedDir(2, 2)
    const p = pool(dir)
    await p.scan()
    const skipped = p.skippedFilesInOrder()
    expect(skipped).toHaveLength(2)
    // The reason matters: "encrypted" is actionable (start the desktop app),
    // whereas "malformed" means the file simply is not a credential. Reporting
    // them alike would send the user after a fix that cannot work.
    for (const entry of skipped) expect(entry.reason).toBe('encrypted')
  }, SLOW)

  it('does not mark an unopenable file as an account in any form', async () => {
    // Guards against a "fix" that counts skips as accounts to make the number
    // match the file count: a credential that cannot be read cannot serve.
    const dir = mixedDir(1, 1)
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.label).toContain('good0')
  }, SLOW)
})

describe('malformed files are handled the same way', () => {
  it('a file that is not valid JSON is skipped, not fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-badjson-'))
    writeFileSync(join(dir, 'workbuddy-desktop.ok.info'), plainCredential('ok'))
    writeFileSync(join(dir, 'workbuddy-desktop.broken.info'), '{ this is not json')
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(1)
    const skipped = p.skippedFilesInOrder()
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.reason).toBe('malformed')
  })

  it('valid JSON that is not a credential is skipped, not fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbpool-wrongshape-'))
    writeFileSync(join(dir, 'workbuddy-desktop.ok.info'), plainCredential('ok'))
    writeFileSync(join(dir, 'not-a-credential.info'), JSON.stringify({ hello: 'world' }))
    const accounts = await pool(dir).scan()
    expect(accounts).toHaveLength(1)
  })
})

describe('the pool still works with only good files', () => {
  it('reports no skips', async () => {
    const dir = mixedDir(3, 0)
    const p = pool(dir)
    const accounts = await p.scan()
    expect(accounts).toHaveLength(3)
    expect(p.skippedFilesInOrder()).toHaveLength(0)
  })
})
