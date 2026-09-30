// @vitest-environment jsdom
/**
 * The usage panel.
 *
 * The arithmetic is covered host-side in `usage.test.ts`; this covers what the
 * user reads. Three things matter, all about not overstating:
 *
 *  - tokens appear only when some request carried a usage frame, so a gateway
 *    that reports nothing shows a request count rather than a confident zero;
 *  - a quiet day keeps its slot in the chart, because closing the gap would
 *    make an idle week look busy;
 *  - the panel stays out of the way entirely when nothing was served, rather
 *    than rendering four zeroed tables that look like a broken feature.
 *
 * @module dsh-workbuddy-xdpool/tests/usage-panel
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoolCard } from '../src/client/PoolCard.tsx'
import { zh } from '../src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOTALS_REPORTED = { requests: 12, tokens: 4200, tokensReported: true }
const TOTALS_UNREPORTED = { requests: 5, tokens: 0, tokensReported: false }

/** A status document whose `usage` summary is `usage`, or absent when undefined. */
function statusWithUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ok: true,
    region: 'cn',
    regions: ['cn', 'global'],
    accounts: [{
      id: 'cn-1',
      label: '青楫渡#29890334',
      domain: '',
      cooling: false,
      disabled: false,
      rateLimitHits: 0,
      creditReserve: 0,
      reserved: false,
    }],
    cooling: 0,
    models: [],
    selection: {},
    distribution: 'priority',
    shim: { running: true, baseUrl: 'http://127.0.0.1:1' },
    creditReserves: {},
    ignored: [],
    ...usage === undefined ? {} : { usage },
  }
}

/** A summary over three days, one of them quiet. */
function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: '2026-09-21',
    to: '2026-09-23',
    days: [
      { key: '2026-09-21', requests: 4, tokens: 1000, tokensReported: true },
      { key: '2026-09-22', requests: 0, tokens: 0, tokensReported: false },
      { key: '2026-09-23', requests: 8, tokens: 3200, tokensReported: true },
    ],
    models: [
      { key: 'hy3', requests: 9, tokens: 3000, tokensReported: true },
      { key: 'deepseek-v4.1-flash', requests: 3, tokens: 1200, tokensReported: true },
    ],
    accounts: [{ key: 'cn-1', requests: 12, tokens: 4200, tokensReported: true }],
    regions: [
      { key: 'cn', requests: 10, tokens: 4000, tokensReported: true },
      { key: 'global', requests: 2, tokens: 200, tokensReported: true },
    ],
    totals: TOTALS_REPORTED,
    ...over,
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

async function render(doc: Record<string, unknown>): Promise<string> {
  vi.stubGlobal('fetch', fakeFetch(doc))
  act(() => { root.render(<PoolCard t={translate} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  return container.textContent ?? ''
}

/** Click one of the panel's breakdown tabs by its label. */
async function openTab(label: string): Promise<string> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-xdpool-seg-btn')]
    .find(entry => entry.textContent?.includes(label))
  if (button === undefined) throw new Error(`no usage tab labelled ${label}`)
  act(() => { button.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  return container.textContent ?? ''
}

describe('usage panel', () => {
  it('shows the window and the totals', async () => {
    const text = await render(statusWithUsage(summary()))

    expect(text).toContain('用量统计')
    expect(text).toContain('2026-09-21 → 2026-09-23')
    expect(text).toContain('请求数')
    expect(text).toContain('12')
    expect(text).toContain('4,200')
    // Today's slice of the window, beside the window total.
    expect(text).toContain('今日 8')
  })

  it('explains an absent token figure instead of printing zero', async () => {
    const text = await render(statusWithUsage(summary({
      totals: TOTALS_UNREPORTED,
      models: [{ key: 'hy3', requests: 5, tokens: 0, tokensReported: false }],
    })))

    expect(text).toContain('未上报')
    expect(text).toContain('5 次')
    // The whole point: no invented token figure beside a real request count.
    expect(text).not.toContain('0 tok')
  })

  it('gives every day a column, including the quiet ones', async () => {
    await render(statusWithUsage(summary()))

    const bars = [...container.querySelectorAll('.dsm-workbuddy-xdpool-usage-bar')]
    expect(bars).toHaveLength(3)
    // The middle day served nothing and still holds its slot.
    expect(bars[1]!.className).toContain('dsm-workbuddy-xdpool-usage-bar-empty')
    expect(bars[0]!.className).not.toContain('empty')
  })

  it('breaks down by model, account, and region', async () => {
    await render(statusWithUsage(summary()))

    expect(container.textContent).toContain('hy3')
    expect(container.textContent).toContain('deepseek-v4.1-flash')

    // Accounts: the id is resolved to the display name, without the uid.
    let text = await openTab('按账号')
    expect(text).toContain('青楫渡')
    expect(text).not.toContain('#29890334')

    // Regions: localized, not the raw `cn` / `global` keys.
    text = await openTab('按区域')
    expect(text).toContain('国内版')
    expect(text).toContain('国际版')
  })

  it('renders nothing at all when no request was served', async () => {
    const text = await render(statusWithUsage(summary({
      totals: { requests: 0, tokens: 0, tokensReported: false },
      days: [],
      models: [],
      accounts: [],
      regions: [],
    })))

    expect(text).not.toContain('用量统计')
  })

  it('renders nothing when the host sends no summary at all', async () => {
    const text = await render(statusWithUsage(undefined))
    expect(text).not.toContain('用量统计')
  })
})
