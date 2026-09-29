// @vitest-environment jsdom
/**
 * The usage row on the pool card.
 *
 * The host-side counting is covered by `usage.test.ts`; this covers the half a
 * user actually sees. Two things matter, and both are about not overstating:
 *
 *  - a model with no token figure must still show its request count, because
 *    "used 3 times, tokens unknown" is the truth for a gateway that sends no
 *    usage frame;
 *  - the token figure must appear when it IS known, or the feature is invisible.
 *
 * @module dsh-workbuddy-xdpool/tests/usage-card
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoolCard } from '../src/client/PoolCard.tsx'
import { zh } from '../src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A status document whose single account carries the given usage rows. */
function statusWithUsage(usageToday: readonly Record<string, unknown>[] | undefined): Record<string, unknown> {
  return {
    ok: true,
    region: 'cn',
    regions: ['cn', 'global'],
    accounts: [{
      id: 'cn-1',
      label: 'cn-acct',
      domain: '',
      cooling: false,
      disabled: false,
      rateLimitHits: 0,
      creditReserve: 0,
      reserved: false,
      ...usageToday === undefined ? {} : { usageToday, usageDate: '2026-09-23' },
    }],
    cooling: 0,
    models: [],
    selection: {},
    distribution: 'priority',
    shim: { running: true, baseUrl: 'http://127.0.0.1:1' },
    creditReserves: {},
    ignored: [],
  }
}

function fakeFetch(doc: Record<string, unknown>): typeof fetch {
  return (async (): Promise<Response> =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
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

/** Render the card against a fixed document and let it settle. */
async function render(doc: Record<string, unknown>): Promise<string> {
  vi.stubGlobal('fetch', fakeFetch(doc))
  act(() => { root.render(<PoolCard t={translate} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  return container.textContent ?? ''
}

/**
 * Render, then open the single account's detail dialog.
 *
 * Per-model usage is deliberately NOT on the page any more — a row carries the
 * account's name and balance, and the dialog carries everything else. So these
 * assertions read the dialog, which is where the user reads them too.
 */
async function renderWithAccountDialog(doc: Record<string, unknown>): Promise<string> {
  await render(doc)
  const row = container.querySelector<HTMLElement>('.dsm-workbuddy-xdpool-row')
  if (row === null) throw new Error('no account row rendered')
  act(() => { row.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  return container.textContent ?? ''
}

describe('usage row on the pool card', () => {
  it('shows the model and request count with tokens when reported', async () => {
    const text = await renderWithAccountDialog(statusWithUsage([
      { modelId: 'deepseek-v4.1-flash', requests: 3, tokens: 1500, tokensReported: true },
    ]))

    expect(text).toContain('今日用量')
    expect(text).toContain('deepseek-v4.1-flash')
    expect(text).toContain('3 次')
    expect(text).toContain('1,500 tok')
  })

  it('shows the request count but claims no token figure when the gateway reported none', async () => {
    const text = await renderWithAccountDialog(statusWithUsage([
      { modelId: 'hy3', requests: 2, tokens: 0, tokensReported: false },
    ]))

    expect(text).toContain('hy3')
    expect(text).toContain('2 次')
    // The whole point: no invented "0 tokens" next to a real request count.
    expect(text).not.toContain('tok')
  })

  it('renders one row per model', async () => {
    const text = await renderWithAccountDialog(statusWithUsage([
      { modelId: 'hy3', requests: 1, tokens: 0, tokensReported: false },
      { modelId: 'glm-5.2', requests: 4, tokens: 200, tokensReported: true },
    ]))

    expect(text).toContain('hy3')
    expect(text).toContain('glm-5.2')
    expect(text).toContain('4 次')
  })

  it('stays quiet when nothing was recorded, rather than printing zeroes', async () => {
    const text = await renderWithAccountDialog(statusWithUsage(undefined))
    expect(text).not.toContain('今日用量')
  })
})
