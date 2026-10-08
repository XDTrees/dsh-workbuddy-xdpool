/**
 * Paid siblings of free models.
 *
 * The gateway prices a product line as SEVERAL rows that share one display
 * name, and it rate-limits each row SEPARATELY. Captured from the live
 * endpoints:
 *
 *   - global `deepseek-v4.1-flash` costs `x0.00` and `deepseek-v4.1-flash-sg`
 *     costs `x0.03`; both are named "Deepseek-V4.1-Flash".
 *   - CN `hy3` costs `x0.00` and `hy3-x` costs `x0.05`; both are named "Hy3".
 *
 * That is the useful fact behind a `429`: when the free row is cooling, the
 * paid row is a DIFFERENT model to the rate limiter and is usually still
 * available. Saying only "every account is rate-limited" leaves the user with
 * no move; naming the sibling gives them one.
 *
 * The family key is the display NAME, not an id prefix: the ids differ in ways
 * no rule captures (`-sg`, `-x`), while the upstream already groups them by
 * name. A name that matches a single row simply has no sibling.
 *
 * @module dsh-workbuddy-xdpool/siblings
 */

/** The minimum shape needed to spot a family and price it. */
export interface SiblingModel {
  id: string
  name: string
  /** Relative credit cost; `0` is the gateways' spelling of "free". */
  multiplier?: number
}

/** A same-family model that costs credits, so it survives a free row's limit. */
export interface PaidSibling {
  id: string
  name: string
  multiplier: number
}

/**
 * The cheapest PAID model sharing `model`'s display name, or undefined.
 *
 * Cheapest rather than first, because the point of the hint is "there is a
 * cheap way out": offering the most expensive twin would make switching look
 * like a trap. A sibling whose price is unknown is skipped — an unpriced row
 * cannot be promised as "the paid one".
 */
export function paidSiblingOf(
  model: { id: string; name: string },
  models: readonly SiblingModel[],
): PaidSibling | undefined {
  let best: PaidSibling | undefined
  for (const candidate of models) {
    if (candidate.id === model.id) continue
    if (candidate.name !== model.name) continue
    const multiplier = candidate.multiplier
    if (multiplier === undefined || multiplier <= 0) continue
    if (best === undefined || multiplier < best.multiplier) {
      best = { id: candidate.id, name: candidate.name, multiplier }
    }
  }
  return best
}

/**
 * The paid sibling of a model, but ONLY when the model itself is free.
 *
 * The guard is the whole point: a `x0.79` row with a `x0.06` cousin is not a
 * "free model with a paid twin", it is just a more expensive row, and labelling
 * it would be noise on most of the list. The hint answers one question — "the
 * free one is limited, what now".
 */
export function paidAlternativeFor(
  model: { id: string; name: string; multiplier?: number },
  models: readonly SiblingModel[],
): PaidSibling | undefined {
  if (model.multiplier !== 0) return undefined
  return paidSiblingOf(model, models)
}
