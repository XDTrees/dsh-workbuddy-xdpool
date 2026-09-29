/**
 * Regression tests for the "models vanished after a restart" defect.
 *
 * Reported: a startup network hiccup made the CN catalog fetch fail, the plugin
 * silently fell back to its built-in table, and the picker lost half its models
 * (`deepseek-v4.1-flash` among them) for the rest of the session. The failure
 * was log-only, and the card's "detect accounts again" button could not fix it
 * because it only re-read desktop snapshots — so the only recovery was
 * restarting DSH.
 *
 * Three separate guards, matching the three things that went wrong:
 *   A. a fetch failure is RETRIED (a startup hiccup is usually gone in a second)
 *   B. the catalog says whether it is live or the built-in table, so the card
 *      can shout about it instead of hiding it in a log
 *   C. a refresh that fails keeps the working list instead of demoting it
 */

import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient, CATALOG_RETRY_BACKOFF_MS } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/accounts.ts'
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'

/** A CN credential; only the fields the catalog fetch reads matter. */
function credential(): WorkBuddyCredential {
  return {
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.cn',
    sourcePath: '/tmp/x.info',
  }
}

/** One live catalog entry in the shape the CN gateway returns. */
function upstreamModel(id: string, name = id) {
  return {
    id,
    name,
    credits: 'x0.79 credits',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsImages: true,
  }
}

/** A success envelope wrapping the given models. */
function okBody(ids: readonly string[]) {
  return JSON.stringify({
    code: 0,
    data: {
      models: ids.map(id => upstreamModel(id)),
      agents: [{ name: 'cli', models: [...ids] }],
    },
  })
}

describe('A. a failed catalog fetch is retried', () => {
  it('recovers when the first attempt fails and the second succeeds', async () => {
    // The exact incident: the network was not up yet on the first try, and the
    // very next request succeeded. One attempt turned that into a session-long
    // downgrade.
    let attempts = 0
    const client = new WorkBuddyUpstreamClient({
      // No real sleeping in tests.
      catalogRetryBackoffMs: [0, 0, 0],
      fetchImpl: (async () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('fetch failed')
        return new Response(okBody(['glm-5.3', 'deepseek-v4.1-flash']), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const models = await client.fetchModels(credential())
    expect(attempts).toBe(2)
    expect(models.map(m => m.id)).toEqual(['glm-5.3', 'deepseek-v4.1-flash'])
  })

  it('keeps retrying up to the ladder, then throws the last error', async () => {
    let attempts = 0
    const client = new WorkBuddyUpstreamClient({
      catalogRetryBackoffMs: [0, 0],
      fetchImpl: (async () => {
        attempts += 1
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })

    await expect(client.fetchModels(credential())).rejects.toThrow('fetch failed')
    // 1 initial + the 2 configured retries.
    expect(attempts).toBe(3)
  })

  it('does not retry a request the caller aborted', async () => {
    // An abort is the CALLER giving up, not a flaky network: retrying it would
    // keep working after we were told to stop.
    let attempts = 0
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const client = new WorkBuddyUpstreamClient({
      catalogRetryBackoffMs: [0, 0, 0],
      fetchImpl: (async () => {
        attempts += 1
        throw abort
      }) as unknown as typeof fetch,
    })

    await expect(client.fetchModels(credential())).rejects.toThrow('aborted')
    expect(attempts).toBe(1)
  })

  it('reports each retry to the logger, so a slow catalog is explainable', async () => {
    const seen: string[] = []
    let attempts = 0
    const client = new WorkBuddyUpstreamClient({
      catalogRetryBackoffMs: [0],
      fetchImpl: (async () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('fetch failed')
        return new Response(okBody(['glm-5.3']), { status: 200 })
      }) as unknown as typeof fetch,
    })
    client.logger = { warn: (...args: unknown[]) => { seen.push(String(args[0])) } }

    await client.fetchModels(credential())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/retrying in/)
  })

  it('an empty ladder means a single attempt', async () => {
    let attempts = 0
    const client = new WorkBuddyUpstreamClient({
      catalogRetryBackoffMs: [],
      fetchImpl: (async () => {
        attempts += 1
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(client.fetchModels(credential())).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it('honours a non-zero backoff before retrying', async () => {
    // The ladder must actually be WAITED, not skipped: a retry that fires
    // immediately would hammer a gateway that just rejected us.
    //
    // Scope note: this does NOT guard the unref'd-timer hang that the first
    // implementation had (a retry that never resumed because the event loop had
    // nothing else keeping it alive). Inside a test runner there are other live
    // handles, so the bug is invisible here — it only bit the real startup path
    // and was caught by the end-to-end run, not by a unit test. Asserting the
    // elapsed time is the closest a unit test gets, and it is still worth
    // having: it fails if the ladder is ever collapsed to zero.
    let attempts = 0
    const started = Date.now()
    const client = new WorkBuddyUpstreamClient({
      catalogRetryBackoffMs: [40],
      fetchImpl: (async () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('fetch failed')
        return new Response(okBody(['glm-5.3']), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const models = await client.fetchModels(credential())
    const elapsed = Date.now() - started
    expect(attempts).toBe(2)
    expect(models.map(m => m.id)).toEqual(['glm-5.3'])
    expect(elapsed).toBeGreaterThanOrEqual(30)
  })

  it('the production ladder is short enough to sit through', () => {
    // This runs during plugin startup, so a long ladder would delay the
    // provider appearing at all. Keep the total well under a minute.
    const total = CATALOG_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0)
    expect(CATALOG_RETRY_BACKOFF_MS.length).toBeGreaterThan(0)
    expect(total).toBeLessThan(30_000)
  })
})

describe('B. the catalog says whether it is live or the built-in table', () => {
  it('starts as fallback, because nothing has been fetched yet', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.currentSource()).toBe('fallback')
    expect(catalog.catalogUpdatedAt()).toBeUndefined()
    expect(catalog.current().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('flips to live once an upstream roster lands', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.updateFromUpstream([upstreamModel('glm-5.3')] as never)
    expect(catalog.currentSource()).toBe('live')
    expect(typeof catalog.catalogUpdatedAt()).toBe('string')
    expect(catalog.lastFetchError()).toBeUndefined()
  })

  it('records the failure message without throwing away the list', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.updateFromUpstream([upstreamModel('glm-5.3'), upstreamModel('deepseek-v4.1-flash')] as never)
    catalog.noteFetchFailure('fetch failed')
    // A failed REFRESH must not demote a working live list.
    expect(catalog.currentSource()).toBe('live')
    expect(catalog.current().map(m => m.id)).toContain('deepseek-v4.1-flash')
    expect(catalog.lastFetchError()).toBe('fetch failed')
  })

  it('a later success clears the recorded error', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.noteFetchFailure('fetch failed')
    expect(catalog.lastFetchError()).toBe('fetch failed')
    catalog.updateFromUpstream([upstreamModel('glm-5.3')] as never)
    expect(catalog.lastFetchError()).toBeUndefined()
  })

  it('reset() goes back to the built-in table and says so', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.updateFromUpstream([upstreamModel('glm-5.3')] as never)
    catalog.reset()
    expect(catalog.currentSource()).toBe('fallback')
  })
})

describe('C. the built-in table hides nothing the user had enabled', () => {
  it('names the models from the report', () => {
    // These are the ones that "vanished". If the table names them, a failed
    // fetch degrades the ROSTER but does not break an existing selection.
    const ids = new Set(FALLBACK_WORKBUDDY_MODELS.map(m => m.id))
    expect(ids.has('deepseek-v4.1-flash')).toBe(true)
  })

  it('every row carries a usable window and output limit', () => {
    // A row with a 0 window would silently cap the context budget downstream.
    for (const model of FALLBACK_WORKBUDDY_MODELS) {
      expect(model.contextWindow, `${model.id} contextWindow`).toBeGreaterThan(0)
      expect(model.maxOutputTokens, `${model.id} maxOutputTokens`).toBeGreaterThan(0)
    }
  })

  it('has no duplicate ids', () => {
    const ids = FALLBACK_WORKBUDDY_MODELS.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
