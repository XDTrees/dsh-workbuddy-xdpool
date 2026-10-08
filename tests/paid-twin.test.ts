/**
 * Tests for the "paid twin" hint.
 *
 * Background, captured from the live gateways: a product line is priced as
 * SEVERAL rows sharing one display name, and each row is rate-limited on its
 * own. The two real families this covers:
 *
 *   global: `deepseek-v4.1-flash` x0.00 / `deepseek-v4.1-flash-sg` x0.03
 *   CN:     `hy3` x0.00 / `hy3-x` x0.05
 *
 * So when a 429 says "every account is rate-limited for model
 * deepseek-v4.1-flash", the useful addition is not sympathy — it is the id of
 * the row that is NOT limited.
 */

import { describe, expect, it } from 'vitest'
import { paidAlternativeFor, paidSiblingOf } from '../src/siblings.ts'

/** The global roster, as the gateway reports it (ids and prices verbatim). */
const GLOBAL = [
  { id: 'hy4-preview-f', name: 'Hy4 preview', multiplier: 0 },
  { id: 'hy3', name: 'Hy3', multiplier: 0 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', multiplier: 0 },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', multiplier: 0.03 },
  { id: 'glm-5.3', name: 'GLM-5.3', multiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', multiplier: 1.62 },
]

/** The CN roster, as the gateway reports it (ids and prices verbatim). */
const CN = [
  { id: 'hy4-preview', name: 'Hy4 preview', multiplier: 0.29 },
  { id: 'hy3', name: 'Hy3', multiplier: 0 },
  { id: 'hy3-x', name: 'Hy3', multiplier: 0.05 },
  { id: 'glm-5.3', name: 'GLM-5.3', multiplier: 0.79 },
]

describe('finding the paid row of a free model', () => {
  it('names the paid twin of a free global model', () => {
    const free = GLOBAL[2] as { id: string; name: string; multiplier: number }
    expect(paidAlternativeFor(free, GLOBAL)).toEqual({
      id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', multiplier: 0.03,
    })
  })

  it('names the paid twin of a free CN model', () => {
    const free = CN[1] as { id: string; name: string; multiplier: number }
    expect(paidAlternativeFor(free, CN)).toEqual({
      id: 'hy3-x', name: 'Hy3', multiplier: 0.05,
    })
  })

  it('matches on the display NAME, not on an id prefix', () => {
    // `-sg` and `-x` share no prefix with their free sibling; only the name
    // groups them. A prefix rule would find nothing here.
    const free = { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', multiplier: 0 }
    const twin = paidAlternativeFor(free, GLOBAL)
    expect(twin?.id).toBe('deepseek-v4.1-flash-sg')
  })

  it('picks the CHEAPEST twin when a family has several paid rows', () => {
    const roster = [
      { id: 'x-free', name: 'X', multiplier: 0 },
      { id: 'x-expensive', name: 'X', multiplier: 1.5 },
      { id: 'x-cheap', name: 'X', multiplier: 0.02 },
    ]
    expect(paidAlternativeFor(roster[0], roster)?.id).toBe('x-cheap')
  })
})

describe('when NOT to label a row', () => {
  it('says nothing for a PAID model, even when a cheaper same-name row exists', () => {
    // `glm-5.3` x0.79 with a x0.06 cousin is not "a free model with a paid
    // twin" — labelling it would put the chip on most of the list.
    const paid = { id: 'glm-5.3', name: 'GLM-5.3', multiplier: 0.79 }
    expect(paidAlternativeFor(paid, [...GLOBAL, { id: 'glm-5.3-flash', name: 'GLM-5.3', multiplier: 0.06 }])).toBeUndefined()
  })

  it('says nothing for a free model whose family is only itself', () => {
    const lone = { id: 'solo', name: 'Solo', multiplier: 0 }
    expect(paidAlternativeFor(lone, [lone, { id: 'other', name: 'Other', multiplier: 0.5 }])).toBeUndefined()
  })

  it('never treats another FREE row as the paid alternative', () => {
    // Two free rows are both limited the same way; switching buys nothing.
    const free = { id: 'a', name: 'Twin', multiplier: 0 }
    const alsoFree = { id: 'b', name: 'Twin', multiplier: 0 }
    expect(paidSiblingOf(free, [free, alsoFree])).toBeUndefined()
  })

  it('skips a sibling whose price is unknown', () => {
    // An unpriced row cannot be promised as "the paid one" — the user would
    // switch expecting a price and might get anything.
    const free = { id: 'a', name: 'Twin', multiplier: 0 }
    const unpriced = { id: 'b', name: 'Twin' }
    expect(paidSiblingOf(free, [free, unpriced])).toBeUndefined()
  })

  it('ignores a model that is not in the roster at all', () => {
    expect(paidAlternativeFor({ id: 'ghost', name: 'Ghost', multiplier: 0 }, GLOBAL)).toBeUndefined()
  })
})
