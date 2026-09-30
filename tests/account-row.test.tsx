// @vitest-environment jsdom
/**
 * The account ROW on the pool card.
 *
 * Four things the row has to get right, all of them about saying one thing and
 * saying it once:
 *
 *  - the number in front of an account is its PICK ORDER, so the first row is
 *    the account the pool will actually serve from;
 *  - a switched-off account is ranked last, not interleaved with the live ones;
 *  - the `#uid` discriminator is an identifier, so it belongs in the dialog and
 *    not in a list the user scans;
 *  - the row carries today's spend, because a free model moves no credits and
 *    the balance therefore cannot show that it was used at all.
 *
 * @module dsh-workbuddy-xdpool/tests/account-row
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PoolCard } from '../src/client/PoolCard.tsx'
import { zh } from '../src/client/locales.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** One account, with every field the row reads. */
function account(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a',
    label: 'acct',
    domain: '',
    cooling: false,
    disabled: false,
    rateLimitHits: 0,
    creditReserve: 0,
    reserved: false,
    ...over,
  }
}

function status(accounts: readonly Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    region: 'cn',
    regions: ['cn', 'global'],
    accounts,
    cooling: 0,
    models: [],
    selection: {},
    distribution: 'priority',
    shim: { running: true, baseUrl: 'http://127.0.0.1:1' },
    creditReserves: {},
    ignored: [],
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

async function render(doc: Record<string, unknown>): Promise<void> {
  vi.stubGlobal('fetch', fakeFetch(doc))
  act(() => { root.render(<PoolCard t={translate} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}

/** The account rows, in the order the card drew them. */
function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.dsm-workbuddy-xdpool-row')]
}

function rankOf(row: HTMLElement): string {
  return row.querySelector('.dsm-workbuddy-xdpool-row-rank')?.textContent ?? ''
}

function nameOf(row: HTMLElement): string {
  return row.querySelector('.dsm-workbuddy-xdpool-row-name')?.textContent ?? ''
}

describe('account rows', () => {
  it('numbers the rows in pick order', async () => {
    await render(status([
      account({ id: 'a', label: 'first' }),
      account({ id: 'b', label: 'second' }),
      account({ id: 'c', label: 'third' }),
    ]))

    expect(rows().map(rankOf)).toEqual(['1', '2', '3'])
    expect(rows().map(nameOf)).toEqual(['first', 'second', 'third'])
  })

  it('ranks switched-off accounts last instead of leaving them in the middle', async () => {
    await render(status([
      account({ id: 'a', label: 'off-one', disabled: true }),
      account({ id: 'b', label: 'live' }),
      account({ id: 'c', label: 'also-live' }),
    ]))

    expect(rows().map(nameOf)).toEqual(['live', 'also-live', 'off-one'])
    // The numbers stay a contiguous queue: the off account is ranked last, not
    // left holding rank 1 while sitting at the bottom.
    expect(rows().map(rankOf)).toEqual(['1', '2', '3'])
  })

  it('keeps the uid discriminator out of the row and inside the dialog', async () => {
    await render(status([account({ id: 'a', label: '青楫渡#29890334', expiresAt: '2026-10-01T00:00:00.000Z' })]))

    expect(nameOf(rows()[0]!)).toBe('青楫渡')
    expect(container.textContent).not.toContain('#29890334')

    act(() => { rows()[0]!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })

    const dialog = container.querySelector('.dsm-workbuddy-xdpool-dialog')
    expect(dialog?.textContent).toContain('29890334')
  })

  it('marks the serving account and the switched-off one with distinct states', async () => {
    await render(status([
      account({ id: 'a', label: 'serving' }),
      account({ id: 'b', label: 'off', disabled: true }),
      account({ id: 'c', label: 'cooling', cooling: true, cooldownUntil: '2026-09-23T10:00:00.000Z' }),
      // Off AND cooling: the user's decision is what the row reports. Reading
      // "cooling" off an account that is switched off is noise.
      account({ id: 'd', label: 'off-and-cooling', disabled: true, cooling: true, cooldownUntil: '2026-09-23T10:00:00.000Z' }),
    ], { activeAccountId: 'a' }))

    const byName = new Map(rows().map(row => [nameOf(row), row]))
    expect(byName.get('serving')!.className).toContain('dsm-workbuddy-xdpool-row-current')
    expect(byName.get('off')!.className).toContain('dsm-workbuddy-xdpool-row-off')
    expect(byName.get('cooling')!.className).toContain('dsm-workbuddy-xdpool-row-warn')
    expect(byName.get('off-and-cooling')!.className).toContain('dsm-workbuddy-xdpool-row-off')
    expect(byName.get('off-and-cooling')!.className).not.toContain('dsm-workbuddy-xdpool-row-warn')
    // The state is carried by colour and the dot, so no state WORD is printed.
    expect(container.textContent).not.toContain('池中')
    expect(container.textContent).not.toContain('当前')
  })

  it("shows today's requests and tokens on the row itself", async () => {
    await render(status([account({
      id: 'a',
      label: 'busy',
      usageTotals: { requests: 7, tokens: 12345, tokensReported: true },
    })]))

    const text = rows()[0]!.textContent ?? ''
    expect(text).toContain('7 次')
    expect(text).toContain('12,345 tok')
  })

  it('states the request count without inventing a token figure', async () => {
    await render(status([account({
      id: 'a',
      label: 'quiet',
      usageTotals: { requests: 2, tokens: 0, tokensReported: false },
    })]))

    const text = rows()[0]!.textContent ?? ''
    expect(text).toContain('2 次')
    expect(text).not.toContain('tok')
  })

  it('shows no usage at all when nothing was recorded', async () => {
    await render(status([account({ id: 'a', label: 'unused' })]))
    expect(container.querySelector('.dsm-workbuddy-xdpool-row-usage')).toBeNull()
  })
})
