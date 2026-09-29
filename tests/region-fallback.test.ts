/**
 * Region-specific model fallbacks.
 *
 * What broke
 * ----------
 * Both gateways were built from ONE fallback list — the domestic roster. The
 * two gateways advertise different model ids, so the international tab showed
 * the domestic roster whenever the live `/v3/config` fetch had not succeeded
 * yet (first paint, fresh install, gateway briefly unreachable): it invented
 * models the global gateway never served and dropped the ones it does
 * (`Balanced`, `Primary`, `Ultimate`, `GPT-6-Astra`, `GPT-5.6-*`, `Grok-4.7`,
 * `Gemini-3.5-Flash`). That is the "国际版模型完全不对" report.
 *
 * These tests pin the property that actually fixes it: the catalog a region
 * gets must fall back to ITS OWN roster, and the wiring in `createCore` must
 * hand each region its own list.
 *
 * @module dsh-workbuddy-xdpool/tests/region-fallback
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  WorkBuddyCatalog,
} from '../src/catalog.ts'

/** Ids the global gateway advertises and the domestic one does not. */
const GLOBAL_ONLY = [
  'balanced-model', 'primary-model', 'deep-model', 'default-model', 'fast-model',
  'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4',
  'grok-4.7', 'gemini-3.5-flash', 'kimi-k3',
]

/** Ids the domestic gateway advertises and the global one does not. */
const CN_ONLY = [
  'deepseek-v4-pro', 'deepseek-v4-flash', 'minimax-m3', 'glm-5.1',
  'glm-5v-turbo', 'hy3-x', 'kimi-k3-1', 'kimi-k2.7', 'auto',
]

/**
 * Ids BOTH gateways serve under the same name.
 *
 * These are the ones that made a naive "global-only" list wrong: the domestic
 * roster was rebuilt from the live endpoint in 1.7.3 and it advertises
 * `kimi-k2.6`, `kimi-k2.8-preview` and `deepseek-v4.1-flash` too. Treating them
 * as region-exclusive would fail against real gateway data, so they are
 * asserted as shared instead.
 */
const SHARED = ['kimi-k2.6', 'kimi-k2.8-preview', 'deepseek-v4.1-flash']

describe('region model fallbacks', () => {
  it('keeps the two rosters distinct', () => {
    const cn = new Set(FALLBACK_WORKBUDDY_MODELS.map(model => model.id))
    const global = new Set(FALLBACK_WORKBUDDY_MODELS_GLOBAL.map(model => model.id))

    // The failure mode was one roster serving both regions. Assert the rosters
    // genuinely differ, in both directions.
    for (const id of GLOBAL_ONLY) {
      expect(global.has(id), `${id} must be in the global fallback`).toBe(true)
      expect(cn.has(id), `${id} must NOT be in the CN fallback`).toBe(false)
    }
    for (const id of CN_ONLY) {
      expect(cn.has(id), `${id} must be in the CN fallback`).toBe(true)
      expect(global.has(id), `${id} must NOT be in the global fallback`).toBe(false)
    }
    for (const id of SHARED) {
      expect(cn.has(id), `${id} is served by BOTH gateways`).toBe(true)
      expect(global.has(id), `${id} is served by BOTH gateways`).toBe(true)
    }
  })

  it('excludes media models that carry no token limits', () => {
    // `gpt-image-*` / `seedance-*` have no token ceilings upstream, so they
    // would render as text-only chat models in the picker.
    for (const model of FALLBACK_WORKBUDDY_MODELS_GLOBAL) {
      expect(model.id, 'media models must not be offered as chat models')
        .not.toMatch(/^gpt-image-|^seedance-/u)
      expect(model.contextWindow, `${model.id} needs a real context window`).toBeGreaterThan(0)
      expect(model.maxOutputTokens, `${model.id} needs a real output ceiling`).toBeGreaterThan(0)
    }
  })

  it('gives each region its own fallback, and reverts to it on reset', () => {
    const global = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS_GLOBAL)
    expect(global.current().map(model => model.id)).toContain('balanced-model')

    // A live catalog arrives, then the upstream goes away again.
    global.updateFromUpstream([
      { id: 'live-only', name: 'Live', contextWindow: 1000, maxTokens: 100 },
    ] as never)
    expect(global.current().map(model => model.id)).toEqual(['live-only'])

    // reset() must come back to the GLOBAL roster, not the domestic one.
    global.reset()
    expect(global.current().map(model => model.id)).toContain('balanced-model')
    expect(global.current().map(model => model.id)).not.toContain('minimax-m3')
  })

  it('keeps the region fallback when an upstream list comes back empty', () => {
    const global = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS_GLOBAL)
    global.updateFromUpstream([])
    expect(global.current().map(model => model.id)).toContain('gpt-6-astra')
  })

  it('wires each region to its own fallback in createCore', () => {
    // The catalog class being region-aware is not enough: the bug lived in the
    // WIRING, where both regions were constructed with the same default. Pin the
    // wiring itself, since a regression there is invisible to the tests above.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(source, 'global catalog must be built from the global fallback')
      .toMatch(/global:\s*new WorkBuddyCatalog\(FALLBACK_WORKBUDDY_MODELS_GLOBAL\)/u)
    expect(source, 'CN catalog must be built from the CN fallback')
      .toMatch(/cn:\s*new WorkBuddyCatalog\(FALLBACK_WORKBUDDY_MODELS\)/u)
  })

  it('spells the desktop UA as a current international build', () => {
    // An unrecognised/old version gets a smaller roster from the global gateway,
    // so a stale UA silently dropped models even when the live fetch succeeded.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'upstream.ts'), 'utf8')
    const match = /const DESKTOP_UA = 'WorkBuddy\/(\d+)\.(\d+)\.(\d+)'/u.exec(source)
    expect(match, 'DESKTOP_UA must be a parsable WorkBuddy version').not.toBeNull()
    const [, major, minor] = match!
    const atLeast = (a: string, b: string): boolean => Number(a) > Number(b)
    expect(
      atLeast(major!, '5') || (major === '5' && Number(minor) >= 6),
      `DESKTOP_UA is ${major}.${minor}; the global gateway truncates rosters below 5.6`,
    ).toBe(true)
  })
})
