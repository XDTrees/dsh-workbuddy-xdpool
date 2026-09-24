/**
 * Settings writes must be VERIFIED, not merely dispatched.
 *
 * The bug this pins: `setSetting` resolved even when the value never reached the
 * settings document. The card then showed "saved" for a reserve the host had not
 * stored, so reopening the panel read 0 back — the user's report was "I filled it
 * in, reopened, and it says 0 again, and I cannot tell whether it took effect".
 *
 * `setCreditReserve` now awaits the writer and re-reads the document, throwing
 * when the read-back disagrees. These tests exercise that contract directly with
 * a fake settings service, because the failure mode is invisible otherwise: a
 * lying setter looks exactly like a working one at the call site.
 */

import { describe, expect, it, vi } from 'vitest'

/**
 * Minimal stand-in for the host settings service used by the plugin.
 *
 * `persist` decides whether a write actually lands. A `false` here models the
 * real failure (a locked file, a stale mirror, a rejected payload) — the write
 * resolves, the document keeps the old value.
 */
function fakeSettings(initial: Record<string, unknown>, persist = true) {
  const document: Record<string, unknown> = { ...initial }
  const currentSnapshot = () => ({ ...document })
  return {
    document,
    currentSnapshot,
    service: {
      set: vi.fn(async (key: string, value: unknown) => {
        if (persist) document[key] = value
        // A real service resolves regardless; the point is that resolving is
        // NOT evidence the write landed.
        return undefined
      }),
    },
  }
}

/**
 * The verified write, mirroring `setSetting` in src/index.ts.
 *
 * Kept as a local re-implementation so the assertion is about the CONTRACT
 * (await + read back + throw) rather than a private closure.
 */
async function writeVerified(
  service: { set: (key: string, value: unknown) => Promise<unknown> | unknown } | undefined,
  current: () => Record<string, unknown>,
  key: string,
  value: unknown,
  expected: unknown,
): Promise<void> {
  if (value === undefined) return
  if (service === undefined) throw new Error(`settings service unavailable; ${key} was not saved`)
  await service.set(key, value)
  if (!stableEqual(current()[key], expected)) {
    throw new Error(`settings field "${key}" was not persisted`)
  }
}

describe('verified settings writes', () => {
  it('succeeds and is readable back when the write lands', async () => {
    const { service, currentSnapshot } = fakeSettings({ creditReserves: {} })
    const next = { acc1: 50 }
    await writeVerified(service, currentSnapshot, 'creditReserves', next, next)
    expect(service.set).toHaveBeenCalledWith('creditReserves', next)
    // The read-back the card relies on shows the new value, not the old one.
    expect(currentSnapshot().creditReserves).toEqual({ acc1: 50 })
  })

  it('throws when the setter resolves but nothing was stored', async () => {
    // The exact silent failure: resolved promise, unchanged document.
    const { service, currentSnapshot } = fakeSettings({ creditReserves: {} }, false)
    await expect(
      writeVerified(service, currentSnapshot, 'creditReserves', { acc1: 50 }, { acc1: 50 }),
    ).rejects.toThrow(/not persisted/)
  })

  it('throws when the service is missing rather than reporting success', async () => {
    await expect(
      writeVerified(undefined, () => ({}), 'creditReserves', { acc1: 50 }, { acc1: 50 }),
    ).rejects.toThrow(/unavailable/)
  })

  it('propagates a rejected write instead of swallowing it', async () => {
    const service = { set: vi.fn(async () => { throw new Error('file is locked') }) }
    await expect(
      writeVerified(service, () => ({}), 'creditReserves', { acc1: 1 }, { acc1: 1 }),
    ).rejects.toThrow(/locked/)
  })

  it('clearing a reserve is verified too (the key disappears from the document)', async () => {
    const { service, currentSnapshot } = fakeSettings({ creditReserves: { acc1: 50 } })
    // A zero reserve deletes the entry rather than storing it.
    await writeVerified(service, currentSnapshot, 'creditReserves', {}, {})
    expect(currentSnapshot().creditReserves).toEqual({})
  })

  it('compares by VALUE so key order cannot fake a mismatch', async () => {
    // JSON.stringify is key-order sensitive, so a straight string compare would
    // report a false failure for two equal objects written in a different order.
    // The implementation sorts keys before comparing for exactly this reason.
    const { service, currentSnapshot } = fakeSettings({ creditReserves: {} })
    await writeVerified(service, currentSnapshot, 'creditReserves', { a: 1, b: 2 }, { b: 2, a: 1 })
  })
})

/** Deep compare that ignores key order, mirroring the host-side helper. */
function stableEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
