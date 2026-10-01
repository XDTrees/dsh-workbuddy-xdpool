/**
 * Time-boxed promotional pricing: which models are free, and when.
 *
 * Why this lives in the plugin rather than coming from the gateway: the
 * announcements describe promotions the API does NOT model. Verified against
 * the live endpoints —
 *
 *   - Hy3's free tier IS reflected (`credits: "x0.00"`), so it needs nothing
 *     from this module; the multiplier alone says "free".
 *   - Hy4-preview's night window is NOT: the catalog reports `credits: "x0.29"`
 *     around the clock, with no field for a time-of-day rule.
 *   - The 14-day newcomer allowance is NOT either, and cannot be: nothing in
 *     the model catalog or the billing packages records whether an account has
 *     ever opened that model. It is account state the plugin is never told.
 *
 * So this module encodes the PUBLIC, TIME-BASED rules only — the part that is
 * knowable without account state. The 14-day allowance is deliberately NOT
 * guessed at: a wrong "free for you!" badge is worse than no badge, because it
 * changes what the user spends.
 *
 * Rules are declared as data so a new promotion is a table entry, and an expiry
 * is automatic: once `until` passes, the rule stops applying on its own.
 *
 * @module dsh-workbuddy-xdpool/promo
 */

/** A model id prefix a rule applies to, and the window it is free in. */
export interface PromoRule {
  /**
   * Matched against the model id as a PREFIX.
   *
   * Prefix rather than equality because the gateway ships sibling ids for one
   * product line (`hy4-preview`, `hy4-preview-x`, and previously
   * `hy4-preview-f`); a promotion covers the family, not one spelling.
   */
  idPrefix: string
  /** Local hours (0-23) the promotion is active in, inclusive start/exclusive end. */
  hours: readonly number[]
  /**
   * Last day the promotion applies, as `YYYY-MM-DD` in local time, inclusive.
   * Absent means "no announced end" — but see {@link PromoStatus.source}.
   */
  until?: string
  /** Short label key for the badge. */
  label: 'night'
}

/**
 * Promotions in force.
 *
 * Source: the WorkBuddy announcement extending Hy3's free tier and
 * Hy4-preview's night window to **2026-10-31**. Hy3 needs no entry here (its
 * price is already zero upstream); only Hy4-preview's time window does, because
 * the gateway charges for it around the clock.
 *
 * When a promotion is extended or a new one starts, edit this table. When one
 * ends, either delete the row or let `until` lapse — both stop the badge.
 */
export const PROMO_RULES: readonly PromoRule[] = [
  {
    // Hy4-preview: free 23:00 - 08:00, "其余时间正常消耗积分".
    // The window CROSSES MIDNIGHT, which is why `hours` is a plain set of clock
    // hours rather than a start/end pair: 23 and 0-7 are all "inside".
    idPrefix: 'hy4-preview',
    hours: [23, 0, 1, 2, 3, 4, 5, 6, 7],
    until: '2026-10-31',
    label: 'night',
  },
]

/** Why a model reads as free right now. */
export type PromoStatus =
  /** Free at all hours (the upstream price is zero, e.g. Hy3). */
  | { kind: 'free' }
  /**
   * Free only inside a time window, and we are inside it.
   *
   * `untilHour` is when the current window closes, so the card can say
   * "free until 08:00" rather than just "free" — the difference matters,
   * because the same model costs credits an hour later.
   */
  | { kind: 'night'; label: 'night'; untilHour: number }
  /**
   * A promotion covers this model but we are OUTSIDE its window.
   *
   * Distinct from "not on promotion" on purpose: the row should hint that
   * waiting is cheaper, without claiming it is free right now.
   */
  | { kind: 'night-later'; label: 'night'; nextHour: number }
  | undefined

/** `YYYY-MM-DD` for a Date in LOCAL time (the promotions are announced locally). */
export function localDayKey(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** Whether a rule is still in force on `date`. */
function ruleActive(rule: PromoRule, date: Date): boolean {
  if (rule.until === undefined) return true
  // String comparison is safe for `YYYY-MM-DD` and avoids timezone parsing.
  return localDayKey(date) <= rule.until
}

/** The first hour the window reopens, searching forward from `hour`. */
function nextWindowHour(rule: PromoRule, hour: number): number | undefined {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24
    if (rule.hours.includes(candidate)) return candidate
  }
  return undefined
}

/** The hour the CURRENT window closes, searching forward from `hour`. */
function windowEndHour(rule: PromoRule, hour: number): number | undefined {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24
    if (!rule.hours.includes(candidate)) return candidate
  }
  return undefined
}

/**
 * The promotion status of one model at `now`.
 *
 * `now` is injected so the behaviour is testable without freezing the clock —
 * a time-dependent badge that can only be tested by waiting is a badge nobody
 * tests.
 */
export function promoStatusFor(
  model: { id: string; multiplier?: number },
  now: Date = new Date(),
): PromoStatus {
  // A genuinely zero-price model is free at every hour; no window applies.
  if (model.multiplier === 0) return { kind: 'free' }

  for (const rule of PROMO_RULES) {
    if (!model.id.startsWith(rule.idPrefix)) continue
    if (!ruleActive(rule, now)) continue
    const hour = now.getHours()
    if (rule.hours.includes(hour)) {
      const untilHour = windowEndHour(rule, hour)
      return { kind: 'night', label: rule.label, untilHour: untilHour ?? hour }
    }
    const nextHour = nextWindowHour(rule, hour)
    if (nextHour !== undefined) {
      return { kind: 'night-later', label: rule.label, nextHour }
    }
  }
  return undefined
}

/**
 * Whether a model is free RIGHT NOW, for sorting.
 *
 * Only the two "currently free" kinds count. `night-later` deliberately does
 * NOT sort to the top: it costs credits at this moment, and floating a
 * credit-priced model above cheaper ones would misrepresent the list.
 */
export function isFreeNow(model: { id: string; multiplier?: number }, now: Date = new Date()): boolean {
  const status = promoStatusFor(model, now)
  return status?.kind === 'free' || status?.kind === 'night'
}
