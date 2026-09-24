/**
 * Overflow-wording contract with the Harness.
 *
 * Why this file exists
 * --------------------
 * `dsh-compaction-basic` only recovers from a context overflow when the text
 * that reaches it satisfies `isContextWindowExceededError()` from
 * `@deepseek-ai/dsh-llm`. That matcher is a fixed set of regexes, so a
 * *human-friendly* overflow message is worse than useless: it is an
 * unclassifiable 400, and the Harness skips its recovery path and surfaces a
 * dead turn.
 *
 * That is exactly the bug this guard was written for. The shim used to answer
 * with "the conversation exceeds <model>'s context window", which matches none
 * of the patterns, and neither does the WorkBuddy upstream's own
 * `input length too long` / code 11115.
 *
 * The regexes below are copied from the installed
 * `dsh-llm/lib/types/error.js`. `isContextWindowExceededError` is the single
 * thing standing between a long conversation and a hard stop, so it is worth
 * pinning: if the Harness ever changes its accepted wording, these tests fail
 * loudly instead of the user silently losing long chats again.
 */

import { describe, expect, it } from 'vitest'
import { contextOverflowMessage } from '../src/shim.ts'

/* ------------------------------------------------------------------ *
 * Verbatim copy of the classifier from @deepseek-ai/dsh-llm error.js
 * ------------------------------------------------------------------ */

const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/** Mirrors `isContextWindowExceededError` from @deepseek-ai/dsh-llm. */
function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/* ------------------------------------------------------------------ *
 * Sanity: the classifier itself still behaves as this file assumes
 * ------------------------------------------------------------------ */

describe('Harness overflow classifier (reference behaviour)', () => {
  it('accepts the canonical phrasings', () => {
    for (const ok of [
      'context_length_exceeded',
      'context length exceeded',
      'context window exceeded',
      "This model's maximum context length is 128000 tokens",
      'Your input exceeds the model’s context window',
      'the prompt is too large for this model context',
      'input too long for the context window',
    ]) {
      expect(isContextWindowExceededError(ok), `should match: ${ok}`).toBe(true)
    }
  })

  it('rejects the wording that used to cause the bug', () => {
    // Both of these were emitted in the field and neither is classifiable.
    for (const miss of [
      "the conversation exceeds glm-5.3-flash's context window",
      'input length too long',
      '{"code":11115,"msg":"input length too long"}',
    ]) {
      expect(isContextWindowExceededError(miss), `should miss: ${miss}`).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * The contract the shim must satisfy
 * ------------------------------------------------------------------ */

describe('contextOverflowMessage', () => {
  it('produces a message the Harness classifies as an overflow', () => {
    expect(isContextWindowExceededError(contextOverflowMessage('glm-5.3-flash'))).toBe(true)
    expect(isContextWindowExceededError(contextOverflowMessage(undefined))).toBe(true)
    expect(isContextWindowExceededError(contextOverflowMessage('hy4-preview', 'prompt still too long'))).toBe(true)
  })

  it('states the matched wording ("maximum context length") for every argument', () => {
    for (const message of [
      contextOverflowMessage('glm-5.3-flash'),
      contextOverflowMessage(undefined),
      contextOverflowMessage('kimi-k3', 'summariser failed'),
    ]) {
      expect(message).toMatch(/maximum context length/i)
    }
  })

  it('names the model when one is known, and stays generic otherwise', () => {
    expect(contextOverflowMessage('glm-5.3-flash')).toContain('glm-5.3-flash')
    expect(contextOverflowMessage(undefined)).not.toContain('undefined')
    expect(contextOverflowMessage(undefined)).toContain('the model')
  })

  it('appends a diagnostic detail only when one is supplied', () => {
    expect(contextOverflowMessage('glm-5.3-flash')).not.toContain('()')
    expect(contextOverflowMessage('glm-5.3-flash', 'prompt still too long')).toContain('prompt still too long')
    // An empty detail must not leave an empty pair of parentheses behind.
    expect(contextOverflowMessage('glm-5.3-flash', '')).not.toMatch(/\(\s*\)/)
  })

  it('keeps the human-readable guidance a person can act on', () => {
    const message = contextOverflowMessage('glm-5.3-flash')
    expect(message).toMatch(/compact|new chat/i)
  })
})
