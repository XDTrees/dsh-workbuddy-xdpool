/**
 * Tests for the pi-ai cross-generation guard.
 *
 * The production failure this prevents: the plugin assembles its provider with
 * one pi-ai generation while the host's `PiAiAdapter` consumes the stream with
 * another. Their terminal-message shapes disagree, the host adapter throws
 * `Cannot read properties of undefined (reading 'length')`, and pi-ai's own
 * catch — which keeps only `message` and drops `stack` — makes the host
 * classify it as a non-retryable `PI_AI_ERROR`. The user sees every turn fail
 * instantly, with no content and no usable error.
 *
 * A package.json range could not prevent it: the old peer range was
 * `>=0.82.1 <0.85.0` while hosts shipped 0.87.x, so the upper bound excluded the
 * host generation and made the mix a legitimate install. These tests cover the
 * resolved-reality check that replaced it.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkPiAiGeneration,
  generationOf,
  piAiGenerationFrom,
  piAiMismatchMessage,
} from '../pi-ai-generation.ts'

/** Build a fake install tree containing `@earendil-works/pi-ai` at `version`. */
function fakeInstall(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'piai-gen-'))
  const pkgDir = join(root, 'node_modules', '@earendil-works', 'pi-ai')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version }),
    'utf8',
  )
  return root
}

describe('generationOf', () => {
  it('reduces a version to major.minor', () => {
    expect(generationOf('0.85.1')).toBe('0.85')
    expect(generationOf('0.87.1')).toBe('0.87')
    expect(generationOf('1.2.3')).toBe('1.2')
  })

  it('tolerates a version it cannot parse', () => {
    // Must not throw: the guard must never break startup.
    expect(generationOf('not-a-version')).toBe('not-a-version')
    expect(generationOf('')).toBe('')
  })
})

describe('piAiGenerationFrom', () => {
  it('reads the version from a resolved install', () => {
    const root = fakeInstall('0.85.1')
    const found = piAiGenerationFrom(root)
    expect(found?.version).toBe('0.85.1')
  })

  it('returns undefined when the package is absent', () => {
    // Optional dependency: no pi-ai installed is a legitimate state, not an error.
    const root = mkdtempSync(join(tmpdir(), 'piai-none-'))
    expect(piAiGenerationFrom(root)).toBeUndefined()
  })
})

describe('checkPiAiGeneration', () => {
  it('aligns when both sides are the same generation', () => {
    const plugin = fakeInstall('0.85.1')
    const host = fakeInstall('0.85.3')
    // A patch difference is expected and must NOT be reported as a mismatch.
    const check = checkPiAiGeneration(plugin, host)
    expect(check.kind).toBe('aligned')
    expect(check.kind === 'aligned' && check.generation).toBe('0.85')
  })

  it('detects the 0.85 / 0.87 split that breaks the adapter seam', () => {
    const plugin = fakeInstall('0.85.1')
    const host = fakeInstall('0.87.1')
    const check = checkPiAiGeneration(plugin, host)
    expect(check.kind).toBe('mismatched')
    if (check.kind !== 'mismatched') return
    expect(check.plugin.version).toBe('0.85.1')
    expect(check.host.version).toBe('0.87.1')
  })

  it('is unknown when either side cannot be resolved', () => {
    const plugin = fakeInstall('0.85.1')
    const empty = mkdtempSync(join(tmpdir(), 'piai-empty-'))
    expect(checkPiAiGeneration(plugin, empty).kind).toBe('unknown')
    expect(checkPiAiGeneration(empty, plugin).kind).toBe('unknown')
  })
})

describe('piAiMismatchMessage', () => {
  it('is silent unless the generations actually differ', () => {
    const aligned = checkPiAiGeneration(fakeInstall('0.85.1'), fakeInstall('0.85.2'))
    expect(piAiMismatchMessage(aligned)).toBeUndefined()
    expect(piAiMismatchMessage({ kind: 'unknown' })).toBeUndefined()
  })

  it('names both versions and tells the user how to fix it', () => {
    const check = checkPiAiGeneration(fakeInstall('0.85.1'), fakeInstall('0.87.1'))
    const message = piAiMismatchMessage(check)
    expect(message).toBeDefined()
    // The two versions, so the report is actionable rather than a vague warning.
    expect(message).toContain('0.85.1')
    expect(message).toContain('0.87.1')
    // And the visible symptom, so a user hitting it can connect the two.
    expect(message).toContain('PI_AI_ERROR')
    // Plus the remedy.
    expect(message).toContain('overrides')
  })
})
