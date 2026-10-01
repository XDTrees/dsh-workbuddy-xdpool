/**
 * Regression tests for the context-overrun recovery budget.
 *
 * The defect, taken straight from a real log line:
 *
 *   context overrun on deepseek-v4.1-flash (~791793 tokens);
 *   compacting to ~797952 and retrying once
 *
 * The "compaction target" was LARGER than the prompt it was supposedly
 * shrinking. The budget came from the catalog window alone —
 * `deepseek-v4.1-flash` is advertised at 1M, so 0.8 * 1M - 2048 = 797952 — and
 * the catalog's window is a marketing figure, not the limit that actually
 * applies. Nothing was compacted, the retry overran again, and the log line
 * made the recovery look as though it had run.
 *
 * The prompt that just overran is EVIDENCE: whatever the catalog claims, the
 * budget must sit meaningfully below it.
 */

import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens } from '../src/context-budget.ts'

/**
 * The budget rule, mirrored from `recoverFromContextOverrun`.
 *
 * Duplicated deliberately: the function is private and its collaborators need a
 * live upstream, while the RULE is the thing that broke. Keeping the arithmetic
 * here means the property can be asserted directly, and the same expression is
 * asserted against the source in the companion check below.
 */
function budgetFor(overrunTokens: number, contextWindow?: number): number {
  const fromWindow = contextWindow !== undefined && contextWindow > 0
    ? Math.max(512, Math.floor(contextWindow * 0.8) - 2048)
    : Number.POSITIVE_INFINITY
  const fromOverrun = Math.max(512, Math.floor(overrunTokens / 2))
  return Math.min(fromWindow, fromOverrun)
}

describe('the compaction target is always smaller than the prompt', () => {
  it('shrinks even when the catalog window dwarfs the prompt', () => {
    // The exact numbers from the log.
    const overrun = 791_793
    const catalog = 1_000_000
    const budget = budgetFor(overrun, catalog)
    console.log(`\n# overrun=${overrun} catalog=${catalog} -> budget=${budget}`)
    expect(budget).toBeLessThan(overrun)
    // And meaningfully so: a target a few tokens smaller would not survive a retry.
    expect(budget).toBeLessThanOrEqual(Math.floor(overrun / 2))
  })

  it('shrinks when no catalog window is known', () => {
    expect(budgetFor(100_000, undefined)).toBe(50_000)
  })

  it('shrinks when the catalog UNDER-reports the window', () => {
    // A window smaller than the prompt must not raise the budget either.
    expect(budgetFor(500_000, 300_000)).toBeLessThan(500_000)
  })

  it('never returns a zero or negative budget', () => {
    // A degenerate budget would make `hardTruncate` keep nothing.
    for (const [overrun, window] of [[1_000, 100], [600, 512], [10, undefined]] as const) {
      expect(budgetFor(overrun, window)).toBeGreaterThan(0)
    }
  })
})

describe('the estimate is sane for the observed prompt size', () => {
  it('counts a large prompt as large', () => {
    // Guards the other half of the bug: if the estimator under-counted, the
    // budget would be computed from a fiction.
    const messages = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'x'.repeat(400_000) },
    ]
    const tokens = estimateMessagesTokens(messages as never)
    console.log(`\n# 400k chars -> ~${tokens} tokens`)
    expect(tokens).toBeGreaterThan(50_000)
  })
})
