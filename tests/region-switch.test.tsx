// @vitest-environment jsdom
/**
 * Region-tab switching on the pool card.
 *
 * The reported bug: switching between 国内版 and 国际版 "卡顿" — the card seizes
 * up instead of showing the other region.
 *
 * These tests drive the REAL component against a fake `fetch` and assert what
 * the user actually sees. The load-bearing invariant is the first one: the tab
 * strip is the only way back to the other region, so it must never depend on
 * the active region's document having arrived.
 *
 * @module dsh-workbuddy-xdpool/tests/region-switch
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoolCard } from '../src/client/PoolCard.tsx'
import { zh } from '../src/client/locales.ts'

// React 18 reads this flag to decide whether `act` is legal in this environment.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Minimal status document: only the fields the card renders. */
function statusDoc(region: 'cn' | 'global'): Record<string, unknown> {
  return {
    ok: true,
    region,
    regions: ['cn', 'global'],
    accounts: [{
      id: `${region}-1`,
      label: `${region}-acct`,
      domain: region === 'global' ? 'workbuddy.ai' : '',
      cooling: false,
      disabled: false,
      rateLimitHits: 0,
      creditReserve: 0,
      reserved: false,
    }],
    cooling: 0,
    models: [{
      id: `${region}-model`,
      name: `${region}-model`,
      supportsImages: true,
      contextWindow: 200_000,
      nativeContextWindow: 200_000,
      maxOutputTokens: 8_000,
      enabled: true,
    }],
    selection: {},
    distribution: 'priority',
    shim: { running: true, baseUrl: 'http://127.0.0.1:1' },
    creditReserves: {},
    ignored: [],
  }
}

/** Interpolate the card's own `{param}` copy, so assertions match real output. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}

/**
 * A `fetch` that answers each region's status after `delayMs`, honouring the
 * caller's AbortSignal the way a real fetch does. `delayMs: null` never settles,
 * which is how the "host is still thinking" state is reproduced.
 */
function fakeFetch(delayMs: number | null): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const impl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const region = new URL(String(input), 'http://localhost').searchParams.get('region') ?? 'cn'
    calls.push(region)
    return new Promise<Response>((resolve, reject) => {
      if (delayMs === null) return // never settles; aborts below still fire
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify(statusDoc(region as 'cn' | 'global')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      }, delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
  }) as typeof fetch
  return { fetch: impl, calls }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

/** Let timers and React commits run inside `act`. */
async function settle(ms: number): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

/** The region tabs currently on screen, in DOM order. */
function tabs(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

/** Find one tab by its visible label. */
function tab(label: string): HTMLButtonElement | undefined {
  return tabs().find(entry => entry.textContent?.includes(label))
}

describe('region tab switching', () => {
  it('renders both region tabs before any status document has arrived', async () => {
    // The host is still probing upstream: nothing has come back yet.
    vi.stubGlobal('fetch', fakeFetch(null).fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(20)

    // The tab strip is the only route to the other region. If it is derived
    // from the active region's document, a slow first load leaves the user with
    // no tabs at all — the freeze the report describes.
    expect(tabs().length, 'both region tabs must be present while loading').toBe(2)
    expect(tab('国内版')).toBeDefined()
    expect(tab('国际版')).toBeDefined()
  })

  it('does not claim a region is empty while its document is still loading', async () => {
    vi.stubGlobal('fetch', fakeFetch(null).fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(20)

    // "No account signed in here yet" is a claim about the account list. With
    // no document we do not know that, and saying it sends the user off to
    // re-sign-in to an account that is already in the pool.
    expect(container.textContent).not.toContain('这边还没有登录')
  })

  it('keeps the tabs and the other region reachable after switching to a region with no document yet', async () => {
    const { fetch } = fakeFetch(40)
    vi.stubGlobal('fetch', fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(120)
    expect(container.textContent).toContain('cn-acct')

    act(() => { tab('国际版')!.click() })
    await settle(5)

    // Mid-flight: the strip must survive, or the user cannot get back to 国内版.
    expect(tabs().length, 'tabs must survive a switch to an unloaded region').toBe(2)
    expect(container.textContent).not.toContain('这边还没有登录')

    // And the international document lands on screen.
    await settle(120)
    expect(container.textContent).toContain('global-acct')

    // Switching back is possible, and 国内版's last answer is still cached.
    act(() => { tab('国内版')!.click() })
    await settle(5)
    expect(container.textContent).toContain('cn-acct')
  })

  it('preserves a region\'s last answer when switching away mid-flight', async () => {
    const { fetch } = fakeFetch(40)
    vi.stubGlobal('fetch', fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(120)
    expect(container.textContent).toContain('cn-acct')

    // Leave for 国际版 and come straight back before its request resolves.
    act(() => { tab('国际版')!.click() })
    await settle(5)
    act(() => { tab('国内版')!.click() })
    await settle(200)

    // 国内版 still shows its account rather than flashing an empty state.
    expect(container.textContent).toContain('cn-acct')
  })

  it('recovers a region whose warm-up failed, without needing a second visit', async () => {
    // The first global request (the background warm-up) fails; the region then
    // has no cached document. A switch to it must fetch for itself and land —
    // which is what breaks if a tab switch aborts the request it just started,
    // or if the switch relies on the warm-up having succeeded.
    let globalAttempts = 0
    vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
      const region = new URL(String(input), 'http://localhost').searchParams.get('region') ?? 'cn'
      if (region === 'global') {
        globalAttempts += 1
        if (globalAttempts === 1) {
          return Promise.resolve(new Response('{"error":"cold"}', { status: 500 }))
        }
      }
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify(statusDoc(region as 'cn' | 'global')), {
            status: 200, headers: { 'content-type': 'application/json' },
          }))
        }, 40)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(150)
    expect(container.textContent).toContain('cn-acct')

    // Switch to 国际版: its warm-up already failed, so this visit must do the
    // fetching itself.
    act(() => { tab('国际版')!.click() })
    await settle(200)

    expect(globalAttempts, 'the switch must retry the failed region').toBeGreaterThan(1)
    expect(container.textContent, 'the retry must reach the screen').toContain('global-acct')
  })

  it('keeps the in-flight answer for the region being left, instead of discarding it', async () => {
    // A status document costs one upstream probe PER ACCOUNT, so an answer that
    // already arrived must be kept even if the user has moved on. If leaving a
    // region aborts its request, the answer is thrown away (the `signal.aborted`
    // guard in `refresh` drops it) and the region has to be fetched again.
    vi.stubGlobal('fetch', fakeFetch(150).fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    // Leave for 国际版 while 国内版's own request is still in flight.
    await settle(50)
    act(() => { tab('国际版')!.click() })
    // Long enough for 国内版's original request to have landed (150ms).
    await settle(300)

    // Coming back must paint 国内版's account immediately, from the answer that
    // was already on its way — not a spinner while it is fetched all over again.
    act(() => { tab('国内版')!.click() })
    expect(container.textContent, 'the in-flight answer must have been kept').toContain('cn-acct')
    expect(container.textContent).not.toContain('正在读取该区域')
  })

  it('switches to the other region with no loading state at all', async () => {
    const { fetch } = fakeFetch(40)
    vi.stubGlobal('fetch', fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    // Long enough for the active region AND the background warm-up to land.
    await settle(200)
    expect(container.textContent).toContain('cn-acct')

    act(() => { tab('国际版')!.click() })

    // Asserted with NO timer advance: the other region's document was warmed in
    // the background, so the switch paints real content on the spot. Without
    // that warm-up (or if a switch aborted the in-flight request) the user gets
    // a spinner here — the "切换卡顿" in the report.
    expect(container.textContent, 'switch must not show a loading state').not.toContain('正在读取该区域')
    expect(container.textContent).toContain('global-acct')
  })

  it('does not render the other region\'s error on this tab', async () => {
    let fail = false
    vi.stubGlobal('fetch', ((input: RequestInfo | URL) => {
      const region = new URL(String(input), 'http://localhost').searchParams.get('region') ?? 'cn'
      if (fail && region === 'global') {
        return Promise.resolve(new Response('{"error":"boom"}', { status: 500 }))
      }
      return Promise.resolve(new Response(JSON.stringify(statusDoc(region as 'cn' | 'global')), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }) as typeof fetch)

    act(() => { root.render(<PoolCard t={translate} />) })
    await settle(120)
    expect(container.textContent).toContain('cn-acct')

    // Make the international side fail, then go look at it.
    fail = true
    act(() => { tab('国际版')!.click() })
    await settle(120)
    expect(container.textContent).toContain('请求失败')

    // Back on 国内版 the card is healthy: one region's failure must not paint
    // the other region as broken.
    act(() => { tab('国内版')!.click() })
    await settle(120)
    expect(container.textContent).not.toContain('请求失败')
    expect(container.textContent).toContain('cn-acct')
  })
})
