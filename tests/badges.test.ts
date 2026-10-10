/**
 * The upstream's own promotion badges, and the static fallback's fidelity.
 *
 * The promo vocabularies this plugin used to expect (`free` / `limited-free` /
 * `night-discount`) are NEVER sent by either gateway. The CN roster instead
 * declares promotions inside `tags` as `badge:<label>:#RRGGBB`:
 *
 *   hy3          credits "x0.00"  tags [craft, badge:限时免费:#FF0000]
 *   hy4-preview  credits "x0.29"  tags [craft, badge:夜间免费:#FF0000]
 *   glm-5.2      credits "x0.79"  tags [craft, badge:夜间折扣:#1E90FF]
 *
 * Every one of those was parsed and then dropped, so a model the gateway had
 * explicitly marked as promoted rendered exactly like a plain paid one.
 *
 * The fixtures below are the REAL values captured from
 * `copilot.tencent.com/v2/enterprises/personal/models` on 2026-10-10.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BADGE_TAG_PREFIX,
  badgeLabels,
  freeBadgeKind,
  hasFreeBadge,
  parseBadgeTags,
  shouldSpellOutFree,
} from '../src/badges.ts'
import { isFreeModel } from '../src/upstream.ts'
import {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  catalogFromUpstream,
  fallbackModelsFor,
} from '../src/catalog.ts'

describe('a badge splits into its label and its colour', () => {
  it('reads the gateway spelling verbatim', () => {
    expect(parseBadgeTags(['craft', 'badge:限时免费:#FF0000'])).toEqual([
      { label: '限时免费', color: 'FF0000' },
    ])
  })

  it('keeps a badge that carries no colour', () => {
    expect(parseBadgeTags(['badge:夜间折扣'])).toEqual([{ label: '夜间折扣' }])
  })

  it('splits on the LAST hash, so a label may contain one', () => {
    // A `C#` label must not lose its character to a colour-looking tail.
    expect(parseBadgeTags(['badge:C#:#1E90FF'])).toEqual([{ label: 'C#', color: '1E90FF' }])
  })

  it('does not mistake a non-hex tail for a colour', () => {
    expect(parseBadgeTags(['badge:活动:下午'])).toEqual([{ label: '活动:下午' }])
  })

  it('drops a badge with an empty label, and every non-badge tag', () => {
    expect(parseBadgeTags(['craft', 'badge:#FF0000', 'badge:'])).toEqual([])
    expect(parseBadgeTags(undefined)).toEqual([])
  })
})

describe('badge labels are shown, not mapped through an English lookup', () => {
  it('lists labels in upstream order, without the colour segments', () => {
    expect(badgeLabels(['craft', 'badge:限时免费:#FF0000', 'badge:夜间折扣:#1E90FF']))
      .toEqual(['限时免费', '夜间折扣'])
  })

  it('treats only 限时免费 as "free right now"', () => {
    // A night discount and a night free window both still cost credits now, so
    // promoting them to a free badge would change what the user spends.
    expect(hasFreeBadge(['badge:限时免费:#FF0000'])).toBe(true)
    expect(hasFreeBadge(['badge:夜间折扣:#1E90FF'])).toBe(false)
    expect(hasFreeBadge(['craft'])).toBe(false)
  })
})

describe('isFreeModel also honours a gateway free badge', () => {
  it('counts a badge even when the price is not zero', () => {
    expect(isFreeModel({ creditMultiplier: 0.29, tags: ['badge:限时免费:#FF0000'] })).toBe(true)
  })

  it('still refuses to invent a discount for a plainly paid model', () => {
    expect(isFreeModel({ creditMultiplier: 0.79, tags: ['badge:夜间折扣:#1E90FF'] })).toBe(false)
  })
})

describe('the static fallback matches the live CN roster', () => {
  const byId = new Map(FALLBACK_WORKBUDDY_MODELS.map(m => [m.id, m]))

  it('names every model the gateway actually serves', () => {
    // A missing row is only visible when a refresh fails, and then it reads as
    // "the plugin deleted a model I had enabled" rather than "the network
    // hiccuped" — which is the incident 1.7.3 was written for.
    for (const id of [
      'auto', 'hy4-preview', 'hy3', 'hy3-x', 'space-bunny',
      'deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash',
      'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'kimi-k3-1', 'kimi-k2.8-preview',
      'kimi-k2.7', 'kimi-k2.6', 'minimax-m3',
    ]) {
      expect(byId.has(id), `${id} must be in the fallback table`).toBe(true)
    }
  })

  it('carries the measured window rather than a rounded-up one', () => {
    // The gateway reports 960K. Advertising 1M is how a session plans a request
    // the upstream then refuses for being over the real window.
    expect(byId.get('hy4-preview')?.contextWindow).toBe(960_000)
  })

  it('prices the models whose rates a refresh failure would otherwise strip', () => {
    expect(byId.get('space-bunny')?.multiplier).toBeCloseTo(0.08)
    expect(byId.get('hy4-preview')?.multiplier).toBeCloseTo(0.29)
  })

  it('keeps the gateway badge tags so a fallback row still advertises the promo', () => {
    expect(byId.get('hy3')?.tags).toContain('badge:限时免费:#FF0000')
    expect(byId.get('hy4-preview')?.tags).toContain('badge:夜间免费:#FF0000')
    expect(byId.get('glm-5.2')?.tags).toContain('badge:夜间折扣:#1E90FF')
  })
})

describe('the free presentation is decided once, in badges.ts', () => {
  it('the gateway badge wins over the generic free label', () => {
    // `限时免费` — "free, for a limited time" — names the half that expires,
    // which a flat `免费` cannot. Collapsing it was the drift this prevents.
    expect(freeBadgeKind({ multiplier: 0, tags: ['craft', 'badge:限时免费:#FF0000'] })).toBe('badge')
    expect(freeBadgeKind({ multiplier: 0.29, tags: ['badge:限时免费:#FF0000'] })).toBe('badge')
  })

  it('falls back to the generic label only when the gateway said nothing', () => {
    expect(freeBadgeKind({ multiplier: 0 })).toBe('generic')
    expect(freeBadgeKind({ multiplier: 0, tags: ['free'] })).toBe('generic')
  })

  it('declines to invent a free badge for a paid row', () => {
    // A night discount still costs credits, so it must not read as free.
    expect(freeBadgeKind({ multiplier: 0.79, tags: ['badge:夜间折扣:#1E90FF'] })).toBeUndefined()
    expect(freeBadgeKind({ multiplier: 0.29 })).toBeUndefined()
  })

  it('does not spell out 免费 on a row the gateway already badged', () => {
    // Emitting both rendered one fact twice: "免费 · 限时免费".
    expect(shouldSpellOutFree({ multiplier: 0, tags: ['badge:限时免费:#FF0000'] })).toBe(false)
    expect(shouldSpellOutFree({ multiplier: 0 })).toBe(true)
    expect(shouldSpellOutFree({ multiplier: 0.79, tags: ['badge:限时免费:#FF0000'] })).toBe(false)
  })
})

describe('each region falls back to its OWN table', () => {
  it('the international table carries no domestic campaign wording', () => {
    // Both regions have always shared one roster, so the CN-only badges rode
    // along into the international picker. Invisible while they sat unparsed in a
    // tag array; now that they are SHOWN, every global row would have advertised
    // a promotion that gateway does not run.
    for (const model of fallbackModelsFor('global')) {
      for (const tag of model.tags ?? []) {
        expect(tag.startsWith(BADGE_TAG_PREFIX), `${model.id} tag ${tag}`).toBe(false)
      }
    }
  })

  it('still names the same models on both sides', () => {
    // Stripping the badges must not empty the picker: an unreachable gateway
    // degrades the roster, it does not delete the user's models.
    expect(fallbackModelsFor('global').map(m => m.id))
      .toEqual(fallbackModelsFor('cn').map(m => m.id))
  })

  it('the catalog falls back per region, and reports the gap in the error only', () => {
    const cn = new WorkBuddyCatalog('cn')
    const global = new WorkBuddyCatalog('global')
    const live = [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000 }] as never
    cn.updateFromUpstream(live)
    global.updateFromUpstream(live)
    cn.reset()
    global.reset()
    expect(cn.currentSource()).toBe('fallback')
    expect(global.currentSource()).toBe('fallback')
    expect(cn.current().find(m => m.id === 'hy3')?.tags).toContain('badge:限时免费:#FF0000')
    expect(global.current().find(m => m.id === 'hy3')?.tags ?? [])
      .not.toContain('badge:限时免费:#FF0000')
  })

  it('defaults to the domestic table, so every existing call site is unchanged', () => {
    expect(fallbackModelsFor()).toBe(FALLBACK_WORKBUDDY_MODELS)
    expect(new WorkBuddyCatalog().current()).toEqual(FALLBACK_WORKBUDDY_MODELS)
    expect(catalogFromUpstream([])).toEqual(FALLBACK_WORKBUDDY_MODELS)
  })
})

describe('the card routes free-ness through the shared decision', () => {
  // A SOURCE-TEXT assertion, not a render test, and the reason is worth stating
  // rather than hiding: `tagFor` in `src/client/PoolCard.tsx` is not exported and
  // that module is not imported by any test (it pulls in React + the whole
  // browser bundle). The rules it implements are therefore tested directly in
  // `badges.ts`; what is left is ORDER, and order is what these two assertions
  // pin down.
  const source = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
  const tagForBody = (() => {
    const start = source.indexOf('function tagFor(')
    expect(start, 'tagFor must still exist in PoolCard.tsx').toBeGreaterThan(-1)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  })()

  it('decides free-ness in badges.ts, not in the card', () => {
    // The picker (adapter.ts) and the card used to answer this question
    // separately and drift: the card collapsed `badge:限时免费` into a flat
    // `row.free`, throwing away the half that expires.
    expect(tagForBody).toContain('freeBadgeKind(model)')
    expect(tagForBody).not.toContain('hasFreeBadge(')
  })

  it('keeps the non-free badge fallback after the paid-tag rules', () => {
    // `glm-5.2` is `x0.79` with `badge:夜间折扣`: it must SHOW that label but
    // must not be read as free. If the badge fallback moved above these, the
    // discount row would be classified as free — changing what the user spends.
    const badgeFallback = tagForBody.indexOf('badgeLabels(tags).length > 0')
    const nightDiscount = tagForBody.indexOf("tags.includes('night-discount')")
    expect(badgeFallback, 'the badge fallback must exist').toBeGreaterThan(-1)
    expect(nightDiscount, 'the night-discount rule must exist').toBeGreaterThan(-1)
    expect(badgeFallback).toBeGreaterThan(nightDiscount)
  })
})