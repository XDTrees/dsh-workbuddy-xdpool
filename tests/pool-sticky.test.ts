/**
 * Sticky distribution: one account per conversation.
 *
 * The upstream prompt cache is keyed by tenant, so rotating accounts *inside* a
 * conversation throws the cache away on every turn — which is why round-robin
 * and balanced measure worse latency and worse hit rate than priority, while
 * priority drains one account's credits. `sticky` is the middle: a conversation
 * keeps its account, and the next NEW conversation takes the next account.
 *
 * `accounts.ts` has no host (dsh-*) dependencies, so this suite runs standalone.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (shims.length > 0) await shims.pop()?.close()
})

/** Write one credential file into `<dir>/auth`. */
async function writeAuth(
  dir: string,
  name: string,
  document: Record<string, unknown>,
): Promise<void> {
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
}

/** `<dir>/auth` holding `count` distinct accounts, in a deterministic order. */
async function accounts(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-sticky-'))
  for (let i = 0; i < count; i += 1) {
    const name = i === 0
      ? 'workbuddy-desktop.info'
      : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.${i}.uuid.info`
    await writeAuth(dir, name, {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 30 * 24 * 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        lastRefreshTime: Date.now() - i * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    })
  }
  return join(dir, 'auth')
}

/** A pool in sticky mode over `count` accounts. */
async function stickyPool(count: number): Promise<WorkBuddyAccountPool> {
  const pool = new WorkBuddyAccountPool({
    authDirs: [await accounts(count)],
    distribution: 'sticky',
  })
  await pool.scan()
  return pool
}

describe('sticky distribution', () => {
  it('serves every turn of one conversation from the same account', async () => {
    const pool = await stickyPool(3)
    const first = await pool.acquire('hy4-preview', undefined, 'chat-a')
    expect(first).toBeDefined()
    for (let turn = 0; turn < 8; turn += 1) {
      expect((await pool.acquire('hy4-preview', undefined, 'chat-a'))!.id).toBe(first!.id)
    }
  })

  it('moves each NEW conversation to the next account in order', async () => {
    const pool = await stickyPool(3)
    const a = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!.id
    const b = (await pool.acquire('hy4-preview', undefined, 'chat-b'))!.id
    const c = (await pool.acquire('hy4-preview', undefined, 'chat-c'))!.id
    // Three conversations, three accounts: the spend still spreads.
    expect(new Set([a, b, c]).size).toBe(3)

    // A fourth conversation wraps around, and the first three are undisturbed.
    expect((await pool.acquire('hy4-preview', undefined, 'chat-d'))!.id).toBe(a)
    expect((await pool.acquire('hy4-preview', undefined, 'chat-b'))!.id).toBe(b)
  })

  it('rebinds a conversation whose account is cooling for that model', async () => {
    const pool = await stickyPool(3)
    const bound = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!
    // A 429 on this model takes the account out of THIS model's pool only.
    pool.penalize(bound.id, Date.now() + 60_000, 'hy4-preview')

    const moved = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!
    expect(moved.id).not.toBe(bound.id)
    // …and the conversation stays on the replacement from then on.
    expect((await pool.acquire('hy4-preview', undefined, 'chat-a'))!.id).toBe(moved.id)
    // The cooldown was model-scoped: the original account is still usable for
    // another model, and re-binding is per (conversation, model availability).
    expect(pool.list().find(a => a.id === bound.id)!.cooldownUntilMs).toBe(0)
  })

  it('rebinds a conversation whose account was switched off', async () => {
    const pool = await stickyPool(3)
    const bound = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!
    pool.applyConfig({ disabledAccountIds: [bound.id] })
    const moved = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!
    expect(moved.id).not.toBe(bound.id)
  })

  it('falls back to rotation when a caller has no conversation key', async () => {
    const pool = await stickyPool(3)
    const seen = new Set<string>()
    for (let i = 0; i < 3; i += 1) seen.add((await pool.acquire('hy4-preview'))!.id)
    // No key means no binding: behaves like round-robin, and remembers nothing.
    expect(seen.size).toBe(3)
    expect(pool.affinitySize()).toBe(0)
  })

  it('ignores the conversation key under every other distribution', async () => {
    const priority = new WorkBuddyAccountPool({ authDirs: [await accounts(3)] })
    await priority.scan()
    const head = (await priority.acquire('hy4-preview', undefined, 'chat-a'))!.id
    expect((await priority.acquire('hy4-preview', undefined, 'chat-b'))!.id).toBe(head)
    expect(priority.affinitySize()).toBe(0)

    const roundRobin = new WorkBuddyAccountPool({
      authDirs: [await accounts(3)],
      distribution: 'round-robin',
    })
    await roundRobin.scan()
    const spread = new Set<string>()
    for (let i = 0; i < 3; i += 1) {
      spread.add((await roundRobin.acquire('hy4-preview', undefined, 'chat-a'))!.id)
    }
    expect(spread.size).toBe(3)
    expect(roundRobin.affinitySize()).toBe(0)
  })

  it('is selectable at runtime and reports itself on the card', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await accounts(3)] })
    await pool.scan()
    expect(pool.currentDistribution()).toBe('priority')

    pool.applyConfig({ distribution: 'sticky' })
    expect(pool.currentDistribution()).toBe('sticky')
    const a = (await pool.acquire('hy4-preview', undefined, 'chat-a'))!.id
    expect((await pool.acquire('hy4-preview', undefined, 'chat-a'))!.id).toBe(a)
  })

  it('bounds how many conversations it remembers', async () => {
    const pool = await stickyPool(3)
    const total = 250
    for (let i = 0; i < total; i += 1) await pool.acquire('hy4-preview', undefined, `chat-${i}`)
    // The map is a memory bound, not a correctness requirement: evicting the
    // oldest conversation only costs it one re-pick on its next turn.
    expect(pool.affinitySize()).toBeLessThanOrEqual(200)
    expect(pool.affinitySize()).toBeGreaterThan(0)

    // A recent conversation still holds its binding…
    const recent = (await pool.acquire('hy4-preview', undefined, `chat-${total - 1}`))!
    expect((await pool.acquire('hy4-preview', undefined, `chat-${total - 1}`))!.id).toBe(recent.id)
    // …and an evicted one is simply bound again, still one account per chat.
    const recycled = (await pool.acquire('hy4-preview', undefined, 'chat-0'))!
    expect((await pool.acquire('hy4-preview', undefined, 'chat-0'))!.id).toBe(recycled.id)
  })

  it('clears every binding on request', async () => {
    const pool = await stickyPool(3)
    await pool.acquire('hy4-preview', undefined, 'chat-a')
    expect(pool.affinitySize()).toBe(1)
    pool.clearAffinity()
    expect(pool.affinitySize()).toBe(0)
  })
})

describe('sticky distribution through the shim', () => {
  /** A fetch stub that reports which access token served each request. */
  function recordingFetch(state: { tokens: string[] }) {
    return async (_url: unknown, init: RequestInit): Promise<Response> => {
      const headers = init.headers as Record<string, string>
      state.tokens.push((headers['Authorization'] ?? '').replace('Bearer ', ''))
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
  }

  /** POST one chat completion, identifying the conversation by its first user message. */
  async function send(shim: { baseUrl(): string; token(): string }, opening: string): Promise<number> {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'hy4-preview',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: opening }],
      }),
    })
    await response.text()
    return response.status
  }

  it('keys the binding off the conversation opening message', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await accounts(3)], distribution: 'sticky' })
    await pool.scan()
    const state = { tokens: [] as string[] }
    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: recordingFetch(state) as never }),
      catalog: new WorkBuddyCatalog(),
    })
    shims.push(shim)
    await shim.ready

    // Bindings are counted, not the token log: the shim also refreshes balances
    // in the background, so the number of upstream calls is not the number of
    // turns. What matters is that the shim derived the SAME key for two turns
    // of one conversation and a DIFFERENT key for a new one.
    expect(pool.affinitySize()).toBe(0)
    expect(await send(shim, 'how do I sort a list')).toBe(200)
    expect(pool.affinitySize()).toBe(1)
    expect(await send(shim, 'how do I sort a list')).toBe(200)
    // Same opening message → same conversation → no second binding.
    expect(pool.affinitySize()).toBe(1)
    expect(await send(shim, 'a different question')).toBe(200)
    expect(pool.affinitySize()).toBe(2)
  })

  it('leaves priority mode untouched: no key is ever bound', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await accounts(3)] })
    await pool.scan()
    const state = { tokens: [] as string[] }
    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: recordingFetch(state) as never }),
      catalog: new WorkBuddyCatalog(),
    })
    shims.push(shim)
    await shim.ready

    expect(await send(shim, 'one')).toBe(200)
    expect(await send(shim, 'two')).toBe(200)
    expect(state.tokens[1]).toBe(state.tokens[0])
    expect(pool.affinitySize()).toBe(0)
  })
})
