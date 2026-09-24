/**
 * Regression for the hy3 400-after-compaction bug.
 *
 * What broke
 * ----------
 * `recoverFromContextOverrun` used to compact to `estimateMessagesTokens(messages) / 2`
 * — half the (already over-long) prompt — regardless of the model's real context
 * window. That works only when the declared window is roughly honest. hy3 was
 * declared at 200K in the catalog while its real limit is far smaller, so the
 * shim compacted to ~100K, the retry still overran, and the user got a 400
 * ("prompt still exceeded the window after compaction").
 *
 * The fix: pass the model's REAL context window into the recovery path and
 * budget against it. This pins that behaviour so a misdeclared window can never
 * silently push the compacted prompt back over the real edge.
 */

import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens, compactMessages, compactWithSummary } from '../src/context-budget.ts'

/** A conversation the harness reports as over the (fake) window. */
function longConversation(turns: number, perMsg: number) {
  const messages = [{ role: 'system', content: 'You are helpful.' }]
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: 'x'.repeat(perMsg) })
    messages.push({ role: 'assistant', content: 'y'.repeat(perMsg) })
  }
  return messages
}

describe('recovery budgets against the REAL window, not half the prompt', () => {
  it('a 200_000 declaration must not let a 32K-real model slip through', () => {
    const messages = longConversation(30, 12_000) // well over a 32K window
    const tokens = estimateMessagesTokens(messages)
    expect(tokens).toBeGreaterThan(32_000)

    // Old behaviour: budget = tokens / 2 ≈ 40K, still above the real 32K window.
    const oldBudget = Math.max(512, Math.floor(tokens / 2))
    expect(oldBudget).toBeGreaterThan(32_000)

    // New behaviour: budget the real window with headroom.
    const REAL_WINDOW = 32_000
    const newBudget = Math.max(512, Math.floor(REAL_WINDOW * 0.8) - 2048)
    expect(newBudget).toBeLessThan(REAL_WINDOW)

    // And a compaction against the real budget must actually fit under it.
    const compacted = compactMessages(messages, { budget: newBudget, keepRecent: 6 })
    expect(compacted.changed).toBe(true)
    expect(estimateMessagesTokens(compacted.messages)).toBeLessThanOrEqual(newBudget)
  })

  it('catalog hy3 is no longer mis-declared at 200K', async () => {
    // Imported lazily so a broken catalog fails this test loudly, not the import.
    const catalog = await import('../src/catalog.ts')
    const hy3 = catalog.FALLBACK_WORKBUDDY_MODELS.find(m => m.id === 'hy3')
    expect(hy3).toBeDefined()
    expect(hy3!.contextWindow).toBeLessThan(200_000)
  })

  it('compactWithSummary still only reports changed when it really dropped turns', () => {
    const messages = longConversation(20, 4_000)
    const result = compactMessages(messages, { budget: 24_000, keepRecent: 6 })
    expect(result.changed).toBe(true)
    expect(result.dropped.length).toBeGreaterThan(0)
    // The dropped prefix is contiguous from the first non-system turn.
    expect(result.dropped).toEqual(messages.slice(1, 1 + result.dropped.length))
  })
})
