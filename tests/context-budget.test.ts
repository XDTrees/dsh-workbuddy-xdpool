/**
 * Context-compaction tests.
 *
 * Regression for "a long conversation dies with context_length_exceeded and
 * the user has to start a new chat". The shim now compacts the prompt in place
 * and retries, so these tests pin the two halves of that behaviour:
 *
 *  - the local budgeting maths (drop-oldest, keep system + newest exchange,
 *    hard truncate, token estimation), and
 *  - the summary-aware compaction, including every fallback path (summariser
 *    unavailable, summariser throws, summary itself over budget).
 *
 * `context-budget.ts` has no host (dsh-*) dependencies, so this suite runs
 * standalone.
 */

import { describe, expect, it } from 'vitest'
import {
  compactMessages,
  compactWithSummary,
  estimateContentTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  hardTruncate,
  transcriptOf,
  type ChatMessage,
} from '../src/context-budget.ts'

/** A message holding roughly `tokens` tokens of latin text. */
function filler(role: string, chars: number, tag = ''): ChatMessage {
  return { role, content: `${tag}${'x'.repeat(chars)}` }
}

/** System + N user/assistant pairs, each `chars` wide. */
function conversation(pairs: number, chars: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are helpful.' }]
  for (let i = 0; i < pairs; i += 1) {
    messages.push(filler('user', chars, `u${i}:`))
    messages.push(filler('assistant', chars, `a${i}:`))
  }
  return messages
}

describe('estimateTextTokens', () => {
  it('treats CJK as roughly one token per character', () => {
    // 8 CJK chars → ~8 tokens, far denser than the latin ratio.
    const cjk = estimateTextTokens('上下文超出了模型的窗口')
    expect(cjk).toBeGreaterThanOrEqual(10)
    expect(cjk).toBeLessThanOrEqual(12)
  })

  it('treats latin as roughly one token per four characters', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('a'.repeat(400))).toBe(100)
  })

  it('mixes the two ratios in one string', () => {
    // 4 latin (1) + 4 CJK (4) = 5.
    expect(estimateTextTokens('abcd中文测试')).toBe(5)
  })
})

describe('estimateContentTokens', () => {
  it('handles the multimodal part shape', () => {
    const tokens = estimateContentTokens([
      { type: 'text', text: 'a'.repeat(400) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
    // 100 for the text plus the per-part floor for the image.
    expect(tokens).toBeGreaterThan(100)
  })

  it('counts tool calls and names carried beside content', () => {
    const withTools: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"p":"a"}' } }],
      name: 'reader',
    }
    expect(estimateMessagesTokens([withTools])).toBeGreaterThan(0)
  })
})

describe('compactMessages', () => {
  it('leaves a prompt that already fits untouched', () => {
    const messages = conversation(2, 40)
    const result = compactMessages(messages, { budget: 1_000_000 })
    expect(result.changed).toBe(false)
    expect(result.dropped).toHaveLength(0)
    expect(result.messages).toHaveLength(messages.length)
  })

  it('drops the oldest turns and keeps system + the newest exchange', () => {
    const messages = conversation(20, 4_000) // far over any small budget
    const result = compactMessages(messages, { budget: 12_000, keepRecent: 4 })

    expect(result.changed).toBe(true)
    expect(result.dropped.length).toBeGreaterThan(0)
    // Every system message survives.
    expect(result.messages.filter(m => m.role === 'system')).toHaveLength(1)
    // The newest user/assistant pair survives verbatim.
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
    expect(result.messages.at(-2)).toEqual(messages.at(-2))
    // And the result now fits.
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(12_000)
  })

  it('never drops below the pinned messages plus the kept tail', () => {
    // System message alone already overruns: compaction must not delete it.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'x'.repeat(40_000) },
      { role: 'user', content: 'hi' },
    ]
    const result = compactMessages(messages, { budget: 100 })
    expect(result.messages.some(m => m.role === 'system')).toBe(true)
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
  })

  it('reports the dropped turns as the summarisation input', () => {
    const messages = conversation(20, 4_000)
    const result = compactMessages(messages, { budget: 12_000, keepRecent: 4 })
    // The dropped prefix is contiguous and starts at index 1 (after `system`).
    expect(result.dropped).toEqual(messages.slice(1, 1 + result.dropped.length))
    expect(result.dropped.length).toBeGreaterThan(0)
  })
})

describe('hardTruncate', () => {
  it('drops from the front until the prompt fits, keeping the newest message', () => {
    const messages = conversation(30, 4_000)
    const result = hardTruncate(messages, 3_000)
    expect(result.changed).toBe(true)
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(3_000)
  })

  it('returns the whole array when it already fits', () => {
    const messages = conversation(1, 40)
    const result = hardTruncate(messages, 1_000_000)
    expect(result.changed).toBe(false)
    expect(result.messages).toEqual(messages)
  })
})

describe('transcriptOf', () => {
  it('renders roles and flattens multimodal content to text', () => {
    const text = transcriptOf([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ])
    expect(text).toContain('### user')
    expect(text).toContain('hello')
    expect(text).toContain('### assistant')
    expect(text).toContain('world')
  })
})

describe('compactWithSummary', () => {
  it('splices a model-produced summary in ahead of the surviving tail', async () => {
    const messages = conversation(20, 4_000)
    let sawTranscript = ''
    const result = await compactWithSummary(
      messages,
      { budget: 12_000, keepRecent: 4 },
      {
        complete: async request => {
          sawTranscript = String(request.at(-1)?.content ?? '')
          return 'SUMMARY: user wanted X; we decided Y.'
        },
      },
    )

    expect(result.summary).toContain('SUMMARY')
    // The summariser saw dropped turns — and only a bounded slice of them, since
    // the transcript handed over is capped at a quarter of the budget.
    expect(sawTranscript).toMatch(/^### (user|assistant)/m)
    expect(sawTranscript.length).toBeLessThan(60_000)
    // The summary rides a system message after the pinned instruction.
    const systemTexts = result.messages
      .filter(m => m.role === 'system')
      .map(m => String(m.content))
    expect(systemTexts.some(t => t.includes('SUMMARY: user wanted X'))).toBe(true)
    expect(systemTexts[0]).toBe('You are helpful.')
    // The newest exchange is still last.
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
    expect(result.tokens).toBeLessThanOrEqual(12_000)
  })

  it('falls back to plain truncation when the summariser throws', async () => {
    const messages = conversation(20, 4_000)
    const result = await compactWithSummary(
      messages,
      { budget: 12_000, keepRecent: 4 },
      { complete: async () => { throw new Error('upstream 429') } },
    )

    expect(result.summary).toBeUndefined()
    expect(result.skipped).toContain('429')
    // Still compacted, still keeps the newest exchange.
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(12_000)
  })

  it('falls back when the summariser returns nothing usable', async () => {
    const messages = conversation(20, 4_000)
    const result = await compactWithSummary(
      messages,
        { budget: 12_000, keepRecent: 4 },
      { complete: async () => '   ' },
    )
    expect(result.summary).toBeUndefined()
    expect(result.skipped).toContain('empty')
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
  })

  it('skips summarisation entirely when the prompt already fits', async () => {
    const messages = conversation(2, 40)
    let called = false
    const result = await compactWithSummary(
      messages,
      { budget: 1_000_000 },
      { complete: async () => { called = true; return 'unused' } },
    )
    expect(called).toBe(false)
    expect(result.summary).toBeUndefined()
    expect(result.messages).toEqual(messages)
  })

  it('hard-truncates when even the summary leaves the prompt over budget', async () => {
    // A summary far larger than the budget must force a second trim. The budget
    // still has to exceed one surviving message, because `hardTruncate` never
    // drops the newest message (a prompt without its final turn is useless).
    const messages = conversation(20, 4_000)
    const result = await compactWithSummary(
      messages,
      { budget: 12_000, keepRecent: 4 },
      { complete: async () => 'S'.repeat(60_000) },
    )
    expect(result.summary).toBeDefined()
    expect(result.tokens).toBeLessThanOrEqual(12_000)
    expect(result.messages.length).toBeGreaterThan(0)
    // The newest exchange still survives; only older turns were trimmed.
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
  })

  it('keeps the newest message even when it alone exceeds the budget', async () => {
    // Documents the hard limit of local truncation: one oversized turn cannot
    // be made to fit, so the caller sees ok: false and surfaces the 400.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(40_000) },
    ]
    const result = await compactWithSummary(
      messages,
      { budget: 500, keepRecent: 1 },
      { complete: async () => { throw new Error('not called') } },
    )
    expect(result.messages.at(-1)).toEqual(messages.at(-1))
  })
})
