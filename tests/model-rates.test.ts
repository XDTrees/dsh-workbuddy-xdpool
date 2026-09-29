/**
 * Regression tests for the model-directory display: the credit multiplier and
 * the free badge.
 *
 * Both were invisible on the international roster even though the upstream was
 * sending everything needed, for two independent reasons:
 *
 *  1. `tags` was parsed into the model object NOWHERE. The JSON carried a
 *     `tags` array; `parseUpstreamModel` simply never read it, and
 *     `toModelInfo` then dropped it again, so the card's promo badges were
 *     unreachable for every model on both gateways.
 *  2. Even once parsed, `free` was awaited as a literal tag — and no gateway
 *     sends one. Zero cost is expressed as `credits: "x0.00"` (global `hy3`,
 *     `hy4-preview-f`, `deepseek-v4.1-flash`), so a genuinely free model
 *     rendered as a plain paid one.
 *
 * The fixtures below are the REAL shapes captured from `www.workbuddy.ai/v3/config`.
 */

import { describe, expect, it } from 'vitest'
import { parseUpstreamModel, isFreeModel } from '../src/upstream.ts'
import { toModelInfo, catalogFromUpstream, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'

/** One entry in the shape the global gateway actually returns. */
function globalModel(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    credits: 'x0.79 credits',
    maxInputTokens: 200_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    ...extra,
  }
}

describe('the upstream tag list survives parsing', () => {
  it('keeps a tags array instead of discarding it', () => {
    const parsed = parseUpstreamModel(globalModel({ tags: ['craft'] }))
    expect(parsed?.tags).toEqual(['craft'])
  })

  it('drops non-string and empty tag entries rather than passing junk through', () => {
    const parsed = parseUpstreamModel(globalModel({ tags: ['craft', '', 42, null, 'image-to-image'] }))
    expect(parsed?.tags).toEqual(['craft', 'image-to-image'])
  })

  it('treats an absent or empty tag list as "no tags"', () => {
    expect(parseUpstreamModel(globalModel({}))?.tags).toBeUndefined()
    expect(parseUpstreamModel(globalModel({ tags: [] }))?.tags).toBeUndefined()
  })

  it('carries tags through to the catalog info', () => {
    const parsed = parseUpstreamModel(globalModel({ tags: ['craft'] }))
    expect(parsed).toBeDefined()
    expect(toModelInfo(parsed!).tags).toEqual(['craft'])
  })
})

describe('free is derived from the multiplier, not awaited as a tag', () => {
  it('a zero-credit model is free', () => {
    // The exact global spelling: hy3 / hy4-preview-f / deepseek-v4.1-flash.
    const parsed = parseUpstreamModel(globalModel({ id: 'hy3', credits: 'x0.00' }))
    expect(parsed?.creditMultiplier).toBe(0)
    expect(isFreeModel(parsed!)).toBe(true)
  })

  it('a paid model is not free', () => {
    const parsed = parseUpstreamModel(globalModel({ credits: 'x0.79 credits' }))
    expect(isFreeModel(parsed!)).toBe(false)
  })

  it('an explicit free tag still counts when a gateway sends one', () => {
    expect(isFreeModel({ tags: ['free'] })).toBe(true)
    expect(isFreeModel({ tags: ['limited-free'] })).toBe(true)
    expect(isFreeModel({ tags: ['craft'] })).toBe(false)
  })
})

describe('the multiplier reaches the catalog info', () => {
  it('parses the two spellings the gateways use', () => {
    // Global: "x0.79" / "x0.79 credits"; CN uses the same "xN.NN" prefix.
    expect(parseUpstreamModel(globalModel({ credits: 'x0.79' }))?.creditMultiplier).toBe(0.79)
    expect(parseUpstreamModel(globalModel({ credits: 'x0.79 credits' }))?.creditMultiplier).toBe(0.79)
    expect(parseUpstreamModel(globalModel({ credits: 'x3.31 credits' }))?.creditMultiplier).toBe(3.31)
  })

  it('an empty credits string is "unknown", NOT free', () => {
    // `default-model` really does send `credits: ""`. Reading that as 0 would
    // brand the default model as free.
    expect(parseUpstreamModel(globalModel({ id: 'default-model', credits: '' }))?.creditMultiplier).toBeUndefined()
  })
})

describe('the static fallback keeps rates and free badges', () => {
  it('carries a multiplier for the ids the gateways price', () => {
    // Without these, an unreachable upstream silently strips every rate and
    // badge — the user sees "the rates disappeared", not "the network failed".
    const byId = new Map(FALLBACK_WORKBUDDY_MODELS.map(m => [m.id, m]))
    expect(byId.get('glm-5.3')?.multiplier).toBeCloseTo(0.79)
    // The CN gateway names this one `kimi-k3-1`; the table used to carry the
    // stale `kimi-k3`, which no longer resolves to anything upstream.
    expect(byId.get('kimi-k3-1')?.multiplier).toBeCloseTo(1.62)
    // hy3 is genuinely free.
    expect(byId.get('hy3')?.multiplier).toBe(0)
  })

  it('carries the models that only exist upstream, so a failed fetch does not hide them', () => {
    // The reported incident: a startup fetch failed, the picker fell back to
    // this table, and `deepseek-v4.1-flash` — which the user had enabled —
    // vanished with no explanation. A table that does not name the models
    // people actually use turns a network hiccup into "the plugin deleted my
    // models".
    const ids = new Set(FALLBACK_WORKBUDDY_MODELS.map(m => m.id))
    for (const id of ['deepseek-v4.1-flash', 'kimi-k3-1', 'minimax-m3', 'auto']) {
      expect(ids.has(id), `${id} must be in the fallback table`).toBe(true)
    }
  })

  it('does not carry ids the gateway has retired', () => {
    // A stale row is worse than a missing one: it looks authoritative, so the
    // user can select it and then get UNKNOWN_MODEL from the provider.
    const ids = new Set(FALLBACK_WORKBUDDY_MODELS.map(m => m.id))
    expect(ids.has('kimi-k3')).toBe(false)
    expect(ids.has('hy4-preview-f')).toBe(false)
  })

  it('the fallback is what shows before the first live fetch, rates included', () => {
    const infos = catalogFromUpstream([])
    const withRate = infos.filter(m => m.multiplier !== undefined)
    expect(withRate.length).toBeGreaterThan(0)
  })
})
