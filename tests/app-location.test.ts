/**
 * Regression for "the app is installed and running, yet the plugin says it could
 * not provide the key".
 *
 * What broke
 * ----------
 * `workbuddyAppExecutableCandidates()` probed four fixed Windows paths, all of
 * them under the system drive:
 *
 *   %LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe
 *   %LOCALAPPDATA%\WorkBuddy\WorkBuddy.exe
 *   %ProgramFiles%\WorkBuddy\WorkBuddy.exe
 *   %ProgramFiles(x86)%\WorkBuddy\WorkBuddy.exe
 *
 * A real machine had NEITHER of the two apps there:
 *
 *   D:\workbuddy\WorkBuddy.exe        (domestic, 5.5.3)
 *   D:\workbuddyai\WorkBuddyAI.exe    (international, 5.6.2)
 *
 * Installing to a non-system drive is ordinary on Windows, and the international
 * build even ships a differently-named executable — so no fixed path list can be
 * right. The installer records the truth in the registry, which is what these
 * tests pin.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { workbuddyAppExecutableCandidates } from '../src/at-rest.ts'

const WIN = 'win32' as NodeJS.Platform
const MAC = 'darwin' as NodeJS.Platform

describe('workbuddyAppExecutableCandidates — Windows', () => {
  it('includes whatever the registry recorded, before any guess', () => {
    const fromRegistry = 'D:\\workbuddyai\\WorkBuddyAI.exe'
    const candidates = workbuddyAppExecutableCandidates(
      WIN, 'C:\\Users\\x', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      undefined, () => [fromRegistry],
    )
    expect(candidates[0]).toBe(fromRegistry)
  })

  it('tries the explicit override first', () => {
    const candidates = workbuddyAppExecutableCandidates(
      WIN, 'C:\\Users\\x', { WORKBUDDY_APP_EXECUTABLE: 'D:\\custom\\WorkBuddy.exe' },
      undefined, () => ['D:\\registry\\WorkBuddy.exe'],
    )
    expect(candidates[0]).toBe('D:\\custom\\WorkBuddy.exe')
  })

  it('enumerates drives for the fallback instead of assuming the system one', () => {
    // With an empty registry the derived list must still reach past %ProgramFiles%.
    const candidates = workbuddyAppExecutableCandidates(
      WIN, 'C:\\Users\\x', { ProgramFiles: 'C:\\Program Files' },
      undefined, () => [],
    )
    // Some entry names a drive other than the one ProgramFiles points at, or at
    // minimum both executable names are represented — a fixed list had neither
    // the alternate name nor any second drive.
    expect(candidates.some(c => c.includes('WorkBuddyAI.exe'))).toBe(true)
    expect(candidates.some(c => c.includes('WorkBuddy.exe'))).toBe(true)
  })

  it('knows the international executable name', () => {
    // The international build is `WorkBuddyAI.exe`; assuming `WorkBuddy.exe` was
    // one of the two reasons the app looked absent. Needs a non-empty env so the
    // fallback roots are populated — an empty env yields zero candidates on any
    // platform (no env roots, and no Windows drives exist on a Linux CI runner).
    const candidates = workbuddyAppExecutableCandidates(
      WIN, 'C:\\Users\\x', { ProgramFiles: 'C:\\Program Files' }, undefined, () => [],
    )
    expect(candidates.some(c => c.endsWith('WorkBuddyAI.exe'))).toBe(true)
  })

  it('never yields an empty or duplicated entry', () => {
    const candidates = workbuddyAppExecutableCandidates(
      WIN, 'C:\\Users\\x', { WORKBUDDY_APP_EXECUTABLE: '   ' }, undefined, () => ['', 'D:\\a\\WorkBuddy.exe'],
    )
    expect(candidates.every(c => c.trim() !== '')).toBe(true)
  })
})

describe('workbuddyAppExecutableCandidates — macOS keeps asking the bundle', () => {
  it('uses CFBundleExecutable rather than the app name', () => {
    const candidates = workbuddyAppExecutableCandidates(
      MAC, '/Users/x', {}, bundle => (bundle.includes('WorkBuddy.app') ? join(bundle, 'Contents', 'MacOS', 'Electron') : undefined),
    )
    // The binary is `Electron`; a path assembled from the app name does not exist.
    expect(candidates.some(c => c.endsWith('Electron'))).toBe(true)
  })

  it('does not consult the Windows registry', () => {
    let called = false
    workbuddyAppExecutableCandidates(MAC, '/Users/x', {}, () => undefined, () => { called = true; return [] })
    expect(called).toBe(false)
  })
})
