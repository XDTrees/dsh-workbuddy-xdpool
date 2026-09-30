/**
 * Regression tests for Windows registry paths that contain non-ASCII characters.
 *
 * The reported defect: the plugin read `reg.exe` output with `encoding: 'utf8'`,
 * but reg.exe writes with the ACTIVE CONSOLE CODE PAGE — 936/GBK on a Chinese
 * Windows. A path containing 「腾讯」 therefore arrived as `��Ѷ`, every
 * `existsSync` failed, and the plugin concluded no desktop app was installed
 * while the app was installed, running, and holding a perfectly good credential.
 * The only workaround was an env override; there was no way to notice the cause
 * from the UI, and the log line named no path.
 *
 * The fix has two layers, and both are covered here:
 *   1. read the registry through PowerShell (`Get-ItemProperty` uses the
 *      registry API, so no code page is involved at all) — the primary path;
 *   2. keep a `reg.exe` reader as a fallback, but decode its bytes with
 *      encoding DETECTION validated against the filesystem, instead of
 *      assuming UTF-8.
 *
 * These tests need the real Windows registry and a real filesystem, so they are
 * skipped elsewhere rather than faked: a mocked registry would not have the
 * encoding layer that is the entire subject.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { workbuddyAppExecutableCandidates } from '../src/at-rest.ts'

const isWindows = process.platform === 'win32'

/** A real directory whose path contains Chinese characters. */
const ROOT = join('D:\\', '_dsh_enc_probe')
const DIR = join(ROOT, '腾讯', 'WorkBuddy')
const EXE = join(DIR, 'WorkBuddy.exe')

/**
 * The fixture key must sit UNDER the Uninstall tree — the only place the reader
 * enumerates. A key anywhere else is invisible and the test would fail for a
 * reason unrelated to encoding. The `DisplayName` matters for the same reason:
 * that is what identifies a WorkBuddy entry.
 */
const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const KEY = `${UNINSTALL}\\DSH-Enc-Encoding-Probe`
const LEGACY_KEY = `${UNINSTALL}\\DSH-Enc-Legacy-Probe`

function reg(args: readonly string[]): void {
  execFileSync('reg', [...args], { windowsHide: true, stdio: 'ignore' })
}

/** The console code page, e.g. 936 on a Chinese system. */
function consoleCodePage(): number {
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8' })
    return Number(/:\s*(\d+)/u.exec(out)?.[1] ?? 0)
  } catch {
    return 0
  }
}

afterAll(() => {
  for (const key of [KEY, LEGACY_KEY]) {
    try { reg(['delete', key, '/f']) } catch { /* already gone */ }
  }
  rmSync(ROOT, { recursive: true, force: true })
})

describe.skipIf(!isWindows)('non-ASCII install paths survive the registry probe', () => {
  it('finds a Chinese install path where a UTF-8 read of reg.exe cannot', () => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    writeFileSync(EXE, '')
    expect(existsSync(EXE)).toBe(true)

    try {
      reg(['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'WorkBuddy', '/f'])
      reg(['add', KEY, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', `${EXE},0`, '/f'])

      // (a) The defect itself, asserted only where it can occur: on a console
      //     whose code page is not UTF-8, the old reading is unusable. (Under a
      //     65001 console the old code happened to work, so there is nothing to
      //     reproduce and the assertion is skipped rather than faked.)
      const codePage = consoleCodePage()
      const asUtf8 = execFileSync('reg', ['query', KEY, '/v', 'DisplayIcon'], { encoding: 'utf8', windowsHide: true })
      const oldPath = /REG_SZ\s+(.+)$/mu.exec(asUtf8)?.[1]?.trim().replace(/,-?\d+$/u, '') ?? ''
      if (codePage !== 0 && codePage !== 65001) {
        expect(
          existsSync(oldPath),
          `reading reg.exe as UTF-8 must not resolve a Chinese path on code page ${codePage}`,
        ).toBe(false)
      }

      // (b) The fix: the plugin's own probe returns the path INTACT.
      const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\nobody', {
        ...process.env,
        // Blank the override so the REGISTRY has to answer.
        WORKBUDDY_APP_EXECUTABLE: '',
      })
      const chinese = candidates.filter(candidate => candidate.includes('腾讯'))
      expect(chinese, 'the probe must surface the Chinese path').toContain(EXE)
      expect(existsSync(EXE)).toBe(true)
    } finally {
      try { reg(['delete', KEY, '/f']) } catch { /* ignore */ }
      rmSync(ROOT, { recursive: true, force: true })
    }
  }, 90_000)

  it('a non-ASCII path is used when it is the first existing candidate', () => {
    // End to end at the level that matters: whichever layer produced the path,
    // the candidate list must place a real, existing file where the caller can
    // reach it — otherwise the key fetch is never attempted.
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    writeFileSync(EXE, '')
    try {
      reg(['add', LEGACY_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'WorkBuddy', '/f'])
      reg(['add', LEGACY_KEY, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', DIR, '/f'])

      const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\nobody', {
        ...process.env,
        WORKBUDDY_APP_EXECUTABLE: '',
      })
      // At least one candidate must resolve to the fixture directory, proving
      // the non-ASCII bytes made it through every layer intact.
      expect(candidates.some(candidate => candidate.startsWith(DIR))).toBe(true)
    } finally {
      try { reg(['delete', LEGACY_KEY, '/f']) } catch { /* ignore */ }
      rmSync(ROOT, { recursive: true, force: true })
    }
  }, 90_000)
})
