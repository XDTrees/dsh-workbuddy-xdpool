/**
 * Per-model daily usage counting.
 *
 * This is the mechanism for the one case the credit reading cannot cover: a
 * free or quota-limited model moves no credits, so the balance is identical
 * whether it was used once or until its daily allowance ran out. The count is
 * therefore the ONLY signal, and three things about it have to hold:
 *
 *  1. the right bucket — (account, model, day), not (account, day);
 *  2. the right moment — once per SERVED stream, never for an account that was
 *     merely tried and rate-limited;
 *  3. the right honesty about tokens — a gateway that sends no usage frame must
 *     read as "unreported", never as a measured zero.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import {
  UNKNOWN_MODEL_ID,
  emptyLedger,
  localDayKey,
  normalizeLedger,
  readUsageLedger,
  recordUsage,
  usageRowsFor,
  writeUsageLedger,
} from '../src/usage.ts'
import { SseUsageReader, usageFromSseFrame } from '../src/usage-stream.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-usage-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/**
 * A fetch stub that rate-limits the first `failures` distinct credentials, then
 * serves the given SSE text. Mirrors the failover tests, so the usage assertions
 * ride the real shim path rather than a hand-rolled call.
 */
function sseFetch(
  failures: number,
  stream: string,
  state: { seen?: Set<string> } = {},
): (url: unknown, init: RequestInit) => Promise<Response> {
  const seen = state.seen ?? new Set<string>()
  state.seen = seen
  return async (_url: unknown, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>
    const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
    seen.add(token)
    if (seen.size <= failures) {
      return new Response(JSON.stringify({ code: 6004, msg: '频率限制' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
}

/** Drive one chat request through a real shim and wait for the stream to drain. */
async function chat(
  shim: { baseUrl(): string; token(): string },
  model = 'hy3',
): Promise<Response> {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  // The counter lands when the upstream stream ends, which is after the client
  // has read the body. Draining here keeps the assertion below deterministic.
  await response.text()
  await new Promise(resolve => setTimeout(resolve, 20))
  return response
}

/** An SSE stream whose final frame carries an OpenAI-shaped usage report. */
const STREAM_WITH_USAGE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}',
  '',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":120,"completion_tokens":30}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

/** An SSE stream with no usage frame at all. */
const STREAM_WITHOUT_USAGE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'

describe('usage ledger arithmetic', () => {
  it('counts per account, per model, per day', () => {
    let ledger = emptyLedger('2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy3' }, '2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy3' }, '2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy4' }, '2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'b', modelId: 'hy3' }, '2026-09-23')

    expect(ledger.accounts['a']!['hy3']!.requests).toBe(2)
    expect(ledger.accounts['a']!['hy4']!.requests).toBe(1)
    expect(ledger.accounts['b']!['hy3']!.requests).toBe(1)
  })

  it('sums reported tokens and marks the request as reported', () => {
    let ledger = emptyLedger('2026-09-23')
    ledger = recordUsage(
      ledger,
      { accountId: 'a', modelId: 'hy3', promptTokens: 120, completionTokens: 30 },
      '2026-09-23',
    )
    ledger = recordUsage(
      ledger,
      { accountId: 'a', modelId: 'hy3', promptTokens: 80, completionTokens: 20 },
      '2026-09-23',
    )
    const counters = ledger.accounts['a']!['hy3']!
    expect(counters.promptTokens).toBe(200)
    expect(counters.completionTokens).toBe(50)
    expect(counters.reportedRequests).toBe(2)
  })

  it('does not treat an absent usage frame as a measured zero', () => {
    let ledger = emptyLedger('2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy3' }, '2026-09-23')
    const counters = ledger.accounts['a']!['hy3']!
    expect(counters.requests).toBe(1)
    expect(counters.reportedRequests).toBe(0)

    const rows = usageRowsFor(ledger, 'a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ modelId: 'hy3', requests: 1, tokens: 0, tokensReported: false })
  })

  it('files a request with no model under a stable marker', () => {
    const ledger = recordUsage(emptyLedger('2026-09-23'), { accountId: 'a', modelId: undefined }, '2026-09-23')
    expect(ledger.accounts['a']![UNKNOWN_MODEL_ID]!.requests).toBe(1)
  })

  it('resets when the day rolls over, so today never means ever', () => {
    let ledger = emptyLedger('2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy3' }, '2026-09-23')
    ledger = recordUsage(ledger, { accountId: 'a', modelId: 'hy3' }, '2026-09-24')

    expect(ledger.date).toBe('2026-09-24')
    expect(ledger.accounts['a']!['hy3']!.requests).toBe(1)
  })

  it('orders rows by most recent use', () => {
    let ledger = emptyLedger('2026-09-23')
    ledger = recordUsage(
      ledger,
      { accountId: 'a', modelId: 'old', at: new Date('2026-09-23T01:00:00Z') },
      '2026-09-23',
    )
    ledger = recordUsage(
      ledger,
      { accountId: 'a', modelId: 'new', at: new Date('2026-09-23T05:00:00Z') },
      '2026-09-23',
    )
    expect(usageRowsFor(ledger, 'a').map(row => row.modelId)).toEqual(['new', 'old'])
  })

  it('returns nothing for an account that served nothing', () => {
    expect(usageRowsFor(emptyLedger('2026-09-23'), 'nobody')).toEqual([])
  })
})

describe('usage ledger persistence', () => {
  it('round-trips through the file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'wbp-usage-file-')), 'usage.json')
    // Today's real key: `readUsageLedger` deliberately discards a ledger from
    // another day, so a fixed fixture date would test the discard path instead.
    const today = localDayKey()
    const ledger = recordUsage(
      emptyLedger(today),
      { accountId: 'a', modelId: 'hy3', promptTokens: 10, completionTokens: 5 },
      today,
    )
    await writeUsageLedger(ledger, path)
    expect(await readUsageLedger(path)).toEqual(ledger)
    // Written atomically, so no temp file is left behind.
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('reads a missing file as an empty ledger rather than throwing', async () => {
    const ledger = await readUsageLedger(join(tmpdir(), 'wbp-usage-absent', 'usage.json'))
    expect(ledger.accounts).toEqual({})
  })

  it('drops a ledger left over from an earlier day', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'wbp-usage-stale-')), 'usage.json')
    // A day that is never today, so the assertion does not depend on the clock.
    await writeUsageLedger(
      recordUsage(emptyLedger('1999-01-01'), { accountId: 'a', modelId: 'hy3' }, '1999-01-01'),
      path,
    )
    const ledger = await readUsageLedger(path)
    expect(ledger.date).not.toBe('1999-01-01')
    expect(ledger.accounts).toEqual({})
  })

  it('survives a malformed document by reading nothing', () => {
    expect(normalizeLedger({ date: '2026-09-23', accounts: 'nonsense' }).accounts).toEqual({})
    expect(normalizeLedger(null).accounts).toEqual({})
    expect(normalizeLedger({ accounts: {} }).accounts).toEqual({})
  })
})

describe('sse usage parsing', () => {
  it('reads the usage frame', () => {
    expect(usageFromSseFrame(STREAM_WITH_USAGE)).toEqual({ promptTokens: 120, completionTokens: 30 })
  })

  it('reads camelCase and nested-envelope spellings', () => {
    expect(usageFromSseFrame('data: {"usage":{"promptTokens":7,"completionTokens":3}}\n'))
      .toEqual({ promptTokens: 7, completionTokens: 3 })
    expect(usageFromSseFrame('data: {"data":{"usage":{"prompt_tokens":9}}}\n'))
      .toEqual({ promptTokens: 9 })
  })

  it('reports nothing when no frame carries usage', () => {
    expect(usageFromSseFrame(STREAM_WITHOUT_USAGE)).toBeUndefined()
    expect(usageFromSseFrame('data: [DONE]\n\n')).toBeUndefined()
  })

  it('ignores an empty usage object instead of reporting zero', () => {
    expect(usageFromSseFrame('data: {"usage":{}}\n')).toBeUndefined()
  })

  it('never throws on malformed frames', () => {
    expect(usageFromSseFrame('data: {not json\n')).toBeUndefined()
    expect(usageFromSseFrame('garbage with no data prefix')).toBeUndefined()
  })

  it('finds a usage frame split across chunk boundaries', () => {
    // The failure this guards: the JSON lands in two chunks, so a per-chunk
    // parse sees two fragments and silently loses the token count.
    const reader = new SseUsageReader()
    const stream = Buffer.from(STREAM_WITH_USAGE, 'utf8')
    const cut = stream.indexOf('prompt_tokens') + 4
    reader.push(stream.subarray(0, cut))
    expect(reader.result()).toBeUndefined()
    reader.push(stream.subarray(cut))
    expect(reader.result()).toEqual({ promptTokens: 120, completionTokens: 30 })
  })

  it('keeps the final report when several frames carry one', () => {
    const reader = new SseUsageReader()
    reader.push('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
    reader.push('data: {"usage":{"prompt_tokens":50,"completion_tokens":25}}\n\n')
    expect(reader.result()).toEqual({ promptTokens: 50, completionTokens: 25 })
  })

  it('reads a final frame that has no trailing newline', () => {
    const reader = new SseUsageReader()
    reader.push('data: {"usage":{"prompt_tokens":11,"completion_tokens":4}}')
    expect(reader.result()).toEqual({ promptTokens: 11, completionTokens: 4 })
  })
})

describe('usage through the shim', () => {
  it('counts a served request with the tokens the upstream reported', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(0, STREAM_WITH_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    await chat(shim)

    expect(pool.usageFor(account.id)).toEqual([
      expect.objectContaining({ modelId: 'hy3', requests: 1, tokens: 150, tokensReported: true }),
    ])
  })

  it('counts the request but reports no tokens when the gateway sends no usage', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(0, STREAM_WITHOUT_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    await chat(shim)

    const rows = pool.usageFor(account.id)
    expect(rows[0]).toMatchObject({ modelId: 'hy3', requests: 1, tokens: 0, tokensReported: false })
  })

  it('counts only the account that actually served a failed-over request', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(3)] })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(2, STREAM_WITH_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    const response = await chat(shim)
    expect(response.status).toBe(200)

    // Exactly one account carries the count: the two that answered 429 were
    // tried, not served, and crediting them would overstate their usage.
    const withUsage = pool.list().filter(account => pool.usageFor(account.id).length > 0)
    expect(withUsage).toHaveLength(1)
    expect(pool.usageFor(withUsage[0]!.id)[0]!.requests).toBe(1)
  })

  it('keeps separate buckets per model on the same account', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(0, STREAM_WITH_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    await chat(shim, 'hy3')
    await chat(shim, 'deepseek-v4.1-flash')

    const byModel = new Map(pool.usageFor(account.id).map(row => [row.modelId, row.requests]))
    expect(byModel.get('hy3')).toBe(1)
    expect(byModel.get('deepseek-v4.1-flash')).toBe(1)
  })

  it('counts a request exactly once even though end and close both fire', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    // The guard is what makes one stream one request: a double count here would
    // make the card report twice the real usage, which is exactly the number a
    // user would act on when deciding whether an allowance is nearly spent.
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(0, STREAM_WITH_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    await chat(shim)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(pool.usageFor(account.id)[0]!.requests).toBe(1)
  })

  it('still counts a stream that fails mid-flight', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    // A body that errors after delivering a partial answer: the user did get a
    // response from this account, so the request has to be counted — otherwise
    // a flaky gateway would look like an unused one.
    const failing = async (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          controller.error(new Error('upstream died mid-flight'))
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    const client = new WorkBuddyUpstreamClient({ fetchImpl: failing as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await response.text().catch(() => '')
    await new Promise(resolve => setTimeout(resolve, 50))

    const rows = pool.usageFor(account.id)
    expect(rows[0]!.requests).toBe(1)
    // Nothing usable arrived, so no token figure may be claimed for it.
    expect(rows[0]!.tokensReported).toBe(false)
  })

  it('persists through the host hook and restores it', async () => {    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    const saved: string[] = []
    pool.setUsagePersistence((ledger) => { saved.push(JSON.stringify(ledger)) })
    const client = new WorkBuddyUpstreamClient({ fetchImpl: sseFetch(0, STREAM_WITH_USAGE) as never })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
    shims.push(shim)
    await shim.ready

    await chat(shim)

    expect(saved.length).toBeGreaterThan(0)
    const restored = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await restored.scan()
    restored.applyUsageLedger(JSON.parse(saved[saved.length - 1]!) as never)
    expect(restored.usageFor(account.id)[0]).toMatchObject({ requests: 1, tokens: 150 })
  })

  it('drops a restored ledger from an earlier day', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(1)] })
    await pool.scan()
    const account = pool.list()[0]!
    pool.applyUsageLedger(
      recordUsage(emptyLedger('1999-01-01'), { accountId: account.id, modelId: 'hy3' }, '1999-01-01'),
    )
    expect(pool.usageFor(account.id)).toEqual([])
  })
})
