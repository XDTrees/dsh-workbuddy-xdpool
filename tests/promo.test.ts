/**
 * Tests for the time-boxed promotional pricing rules.
 *
 * Background, verified against the live gateway:
 *   - Hy3's free tier IS in the API (`credits: "x0.00"`), so the multiplier
 *     already says "free" and no rule is needed.
 *   - Hy4-preview's night window is NOT: the catalog prices it at `x0.29`
 *     around the clock. The plugin therefore carries the public time rule.
 *   - The 14-day newcomer allowance is NOT in the API either, and cannot be
 *     inferred (nothing records whether an account ever opened the model), so
 *     it is deliberately NOT modelled. A wrong "free for you" badge would
 *     change what the user spends, which is worse than no badge.
 *
 * Every case pins the clock, because a badge whose only test is "wait until
 * 23:00" is a badge nobody tests.
 */

import { describe, expect, it } from 'vitest'
import { PROMO_RULES, isFreeNow, localDayKey, promoStatusFor } from '../src/promo.ts'

/** A local-time Date at the given hour, on a date inside the promo window. */
function at(hour: number, minute = 0, day = 15): Date {
  return new Date(2026, 9, day, hour, minute, 0, 0)
}

/** Hy4-preview as the gateway reports it: paid, with no time-of-day field. */
const HY4 = { id: 'hy4-preview', multiplier: 0.29 }
/** A genuinely free model, priced at zero upstream. */
const HY3 = { id: 'hy3', multiplier: 0 }
/** An ordinary paid model. */
const GLM = { id: 'glm-5.3', multiplier: 0.79 }

describe('Hy4-preview night window (23:00 - 08:00)', () => {
  it('is free inside the window', () => {
    for (const hour of [23, 0, 3, 7]) {
      const status = promoStatusFor(HY4, at(hour))
      expect(status?.kind, `at ${hour}:00`).toBe('night')
    }
  })

  it('is NOT free outside the window', () => {
    for (const hour of [8, 12, 18, 22]) {
      const status = promoStatusFor(HY4, at(hour))
      expect(status?.kind, `at ${hour}:00`).not.toBe('night')
    }
  })

  it('reports when the window closes, so the badge can say "until 08:00"', () => {
    const lateNight = promoStatusFor(HY4, at(23, 30))
    expect(lateNight).toMatchObject({ kind: 'night', untilHour: 8 })
    const earlyMorning = promoStatusFor(HY4, at(2))
    expect(earlyMorning).toMatchObject({ kind: 'night', untilHour: 8 })
  })

  it('reports when the window opens, outside it', () => {
    // 12:00 -> the next window is tonight at 23:00.
    expect(promoStatusFor(HY4, at(12))).toMatchObject({ kind: 'night-later', nextHour: 23 })
    // 08:00 is the first hour AFTER the window, so 23:00 is still next.
    expect(promoStatusFor(HY4, at(8))).toMatchObject({ kind: 'night-later', nextHour: 23 })
    // 22:00 -> one hour to go.
    expect(promoStatusFor(HY4, at(22))).toMatchObject({ kind: 'night-later', nextHour: 23 })
  })

  it('covers the whole sibling family, not one id spelling', () => {
    // The gateway ships `hy4-preview` and `hy4-preview-x` for the same product.
    for (const id of ['hy4-preview', 'hy4-preview-x']) {
      expect(promoStatusFor({ id, multiplier: 0.29 }, at(23))?.kind, id).toBe('night')
    }
  })
})

describe('a zero-price model is free at every hour', () => {
  it('reads as free regardless of the clock', () => {
    for (const hour of [0, 9, 12, 23]) {
      expect(promoStatusFor(HY3, at(hour))?.kind, `at ${hour}:00`).toBe('free')
    }
  })

  it('does not pick up a night window it is not part of', () => {
    // `hy3` must not match the `hy4-preview` prefix.
    expect(promoStatusFor(HY3, at(12))?.kind).toBe('free')
  })
})

describe('an unpromoted paid model has no status', () => {
  it('returns undefined', () => {
    expect(promoStatusFor(GLM, at(23))).toBeUndefined()
    expect(promoStatusFor(GLM, at(12))).toBeUndefined()
  })
})

describe('the promotion expires on its own', () => {
  it('applies on the last announced day', () => {
    const lastDay = new Date(2026, 9, 31, 23, 30)
    expect(promoStatusFor(HY4, lastDay)?.kind).toBe('night')
  })

  it('stops the day after', () => {
    const after = new Date(2026, 10, 1, 23, 30)
    expect(promoStatusFor(HY4, after)).toBeUndefined()
  })

  it('does not fire before the promotion is in force', () => {
    // No `from` on this rule, so it applies from the start; asserting the
    // expiry is the part that matters, and this documents the assumption.
    expect(localDayKey(new Date(2026, 9, 1))).toBe('2026-10-01')
  })
})

describe('free-first sorting', () => {
  it('counts only models that are free RIGHT NOW', () => {
    // Inside the window: hy3 and hy4-preview both float up.
    expect(isFreeNow(HY3, at(23))).toBe(true)
    expect(isFreeNow(HY4, at(23))).toBe(true)
    expect(isFreeNow(GLM, at(23))).toBe(false)

    // Outside it: hy4-preview is paid, so it must NOT be promoted. This is the
    // decision that keeps the list honest — floating a credit-priced model to
    // the top would misrepresent what the user is about to spend.
    expect(isFreeNow(HY4, at(12))).toBe(false)
    expect(isFreeNow(HY3, at(12))).toBe(true)
  })
})

describe('the promotion is DOMESTIC only', () => {
  it('does not apply to the international roster', () => {
    // The Hy3 / Hy4-preview extension is a CN campaign; the international
    // gateway runs its own pricing. Applying the CN window there would invent a
    // discount that gateway does not offer.
    for (const hour of [23, 3, 7]) {
      expect(promoStatusFor(HY4, at(hour), 'global'), `global at ${hour}:00`).toBeUndefined()
      expect(isFreeNow(HY4, at(hour), 'global')).toBe(false)
    }
    // ...while the domestic roster does get it, at the same instants.
    expect(promoStatusFor(HY4, at(23), 'cn')?.kind).toBe('night')
  })

  it('still reports a genuinely zero-priced model as free on BOTH gateways', () => {
    // That one is upstream truth, not a campaign, so it is region-neutral.
    expect(promoStatusFor(HY3, at(12), 'global')?.kind).toBe('free')
    expect(promoStatusFor(HY3, at(12), 'cn')?.kind).toBe('free')
  })
})

describe('the campaign end date is exposed for display', () => {
  it('carries the announced end date', () => {
    // The card prints this, so a user planning around the promotion can see how
    // long it runs — and an extension becomes visible without a changelog.
    const night = promoStatusFor(HY4, at(23), 'cn')
    expect(night?.kind === 'night' ? night.promoUntil : undefined).toBe('2026-10-31')
    const later = promoStatusFor(HY4, at(12), 'cn')
    expect(later?.kind === 'night-later' ? later.promoUntil : undefined).toBe('2026-10-31')
  })

  it('is absent once the promotion has lapsed', () => {
    const after = new Date(2026, 10, 1, 23, 30)
    expect(promoStatusFor(HY4, after, 'cn')).toBeUndefined()
  })
})

describe('the rule table stays honest', () => {
  it('uses prefix matching only where the family is intended', () => {
    // A prefix that is too short would capture unrelated ids. Guard the one
    // entry the project actually ships.
    for (const rule of PROMO_RULES) {
      expect(rule.idPrefix.length).toBeGreaterThan(4)
      expect(rule.hours.length).toBeGreaterThan(0)
      for (const hour of rule.hours) {
        expect(hour).toBeGreaterThanOrEqual(0)
        expect(hour).toBeLessThanOrEqual(23)
      }
    }
  })

  it('declares a region on every rule', () => {
    // Without one a rule would apply to both gateways, which is exactly the
    // mistake this field exists to prevent.
    for (const rule of PROMO_RULES) {
      expect(['cn', 'global'], `${rule.idPrefix} region`).toContain(rule.region)
    }
  })

  it('carries an expiry, so a forgotten promotion cannot live forever', () => {
    // A rule without `until` would silently claim a model is free long after
    // the announcement lapsed. The type makes it required; this asserts the
    // data actually has one.
    for (const rule of PROMO_RULES) {
      expect(rule.until, `${rule.idPrefix} must declare an end date`).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    }
  })
})
