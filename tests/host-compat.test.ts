/**
 * One build has to serve two DSH host lines whose settings APIs are mutually
 * exclusive, and the failure mode of getting it wrong is not a broken card —
 * it is a host that will not start.
 *
 * The reports this pins:
 *
 *  - 0.1.7-rc.1/rc.2: `ctx.settings.installSection(...)` is not a function on
 *    that line (`SettingsForms` replaced it with `configure({auto}, owner)`), so
 *    calling it unconditionally threw from inside `apply`.
 *  - 0.1.5-rc.2: the client half declared `configForms` in its `inject`, a
 *    service that line does not provide. Cordis never runs `apply` for a fiber
 *    whose inject is unsatisfied, so the entry stayed PENDING and the Desktop
 *    refused to open with "renderer boot failed".
 *  - `settings.plugin.item`, the slot the card used to register into, does not
 *    exist on 0.1.7 at all — so the card silently never appeared.
 *  - On 0.1.7 a volatile field arrives as a live `{get(): T}` reference. Reading
 *    it without unwrapping compares an object against a string, so a saved value
 *    reads back as unset.
 *
 * These tests exercise the CONTRACTS directly (capability probe, unwrap, slot
 * choice, inject list) rather than importing the plugin entry, because the real
 * entry pulls in the whole host-side runtime.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyScheduler, dayKey } from '../src/scheduler.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Source of the host entry, read as text for the structural assertions. */
const hostSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
/** Source of the browser entry. */
const clientSource = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/**
 * Mark a schema field volatile the way `src/index.ts` does.
 *
 * Mirrors `asVolatile`: the marker exists from schemastery 3.18.3 (the 0.1.7
 * line), and on the older line the schema must stay byte-identical to the
 * unmarked original — hand-writing `meta.volatile = true` would bypass
 * schemastery's own placement validation and hand that line a shape it does not
 * understand. So a missing method is an identity no-op, not an error.
 */
function asVolatile<S>(schema: S): S {
  const candidate = schema as unknown as { volatile?: () => S }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/** Mirror of the host-side one-level unwrap. */
function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/** Mirror of the host-side deep unwrap. */
function unwrapVolatileDeep<T>(value: T): T {
  const peeled = unwrapVolatile(value)
  if (Array.isArray(peeled)) return peeled.map(entry => unwrapVolatileDeep(entry)) as T
  if (peeled !== null && typeof peeled === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry)
    return out as T
  }
  return peeled
}

/** A settings service exposing only the 0.1.7 API. */
function formsLine() {
  const calls: string[] = []
  return {
    calls,
    service: {
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        calls.push(`configure:${String(presentation.auto)}:${String(owner)}`)
        return () => { calls.push('dispose') }
      },
      update: async () => { calls.push('update') },
    },
  }
}

/** A settings service exposing only the 0.1.5 API. */
function providerLine() {
  const calls: string[] = []
  return {
    calls,
    service: {
      installSection: (owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: unknown) => {
        calls.push(`installSection:${ns}`)
        return { owner, schema, entry, hooks }
      },
      update: async () => { calls.push('update') },
    },
  }
}

/**
 * The registration branch, mirroring `src/index.ts`.
 *
 * Returns which path ran so the caller can assert the two lines never both fire
 * and never both stay silent.
 */
function registerSettings(service: Record<string, unknown>, ctx: { effect: (fn: () => unknown) => void; logger: { warn: (m: string) => void } }) {
  const installed: string[] = []
  if (typeof service.installSection === 'function') {
    ;(service.installSection as (...args: unknown[]) => unknown)('ctx', 'workbuddy-xdpool', {}, {}, {})
    installed.push('installSection')
  }
  if (typeof service.configure === 'function') {
    ctx.effect(() => (service.configure as (p: { auto?: boolean }, o?: unknown) => unknown)({ auto: true }, 'fiber'))
    installed.push('configure')
  }
  if (typeof service.installSection !== 'function' && typeof service.configure !== 'function') {
    ctx.logger.warn('dsh-workbuddy-xdpool: settings service exposes neither installSection nor configure; the card will not mount')
    installed.push('none')
  }
  return installed
}

describe('settings registration across both host lines', () => {
  it('uses configure on the 0.1.7 line, and never touches installSection', () => {
    const { service, calls } = formsLine()
    const effects: (() => unknown)[] = []
    const installed = registerSettings(service, { effect: fn => effects.push(fn), logger: { warn: () => {} } })

    expect(installed).toEqual(['configure'])
    // The disposer must be registered with the plugin's effects, or the
    // presentation policy outlives disposal.
    expect(effects).toHaveLength(1)
    effects[0]?.()
    expect(calls).toContain('configure:true:fiber')
    // No `installSection` call was attempted: on this line that would throw
    // "is not a function" from inside apply and take the plugin down.
    expect(calls.some(call => call.startsWith('installSection'))).toBe(false)
  })

  it('uses installSection on the 0.1.5 line, and never calls configure', () => {
    const { service, calls } = providerLine()
    const installed = registerSettings(service, { effect: () => {}, logger: { warn: () => {} } })

    expect(installed).toEqual(['installSection'])
    expect(calls).toEqual(['installSection:workbuddy-xdpool'])
    expect(calls.some(call => call.startsWith('configure'))).toBe(false)
  })

  it('warns instead of throwing when neither API exists', () => {
    const warnings: string[] = []
    const installed = registerSettings({}, { effect: () => {}, logger: { warn: m => warnings.push(m) } })

    expect(installed).toEqual(['none'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/neither installSection nor configure/)
  })

  it('the host entry probes both capabilities rather than assuming one', () => {
    // Structural: both guards must be present, because naming only one is the
    // exact defect that broke the other line.
    expect(hostSource).toContain("typeof settingsService.installSection === 'function'")
    expect(hostSource).toContain("typeof settingsService.configure === 'function'")
  })

  it('the host entry listens for 0.1.7 volatile updates', () => {
    // Without this the 0.1.7 line persists an edit but the running instance
    // never re-reads it, so a save appears to do nothing until a restart.
    expect(hostSource).toContain("loader/volatile-update")
  })

  it('every Config field is marked volatile', () => {
    // The 0.1.7 write gate refuses an entry whose schema declares no volatile
    // field at all, and describe() skips such an entry — so an unmarked field
    // is a save that throws and a page that renders empty.
    const start = hostSource.indexOf('export const Config: z<Config> = z.object({')
    const end = hostSource.indexOf('\n})', start)
    const body = hostSource.slice(start, end)
    const lines = body.split('\n').filter(line => /^\s{2}\w+:/.test(line))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, `field not wrapped: ${line.trim()}`).toContain('asVolatile(')
    }
  })
})

describe('volatile marking degrades to identity without the method', () => {
  it('returns the same schema object when volatile() is absent', () => {
    const plain = { marker: 'plain' }
    expect(asVolatile(plain)).toBe(plain)
  })

  it('calls volatile() when the schema provides it', () => {
    let called = 0
    const schema = {
      volatile() { called += 1; return this },
    }
    expect(asVolatile(schema)).toBe(schema)
    expect(called).toBe(1)
  })
})

describe('live volatile references are unwrapped before use', () => {
  it('peels a single live reference', () => {
    const live = { get: () => 'resolved' }
    expect(unwrapVolatile(live)).toBe('resolved')
  })

  it('leaves an ordinary value alone', () => {
    expect(unwrapVolatile('plain')).toBe('plain')
    expect(unwrapVolatile(0)).toBe(0)
    expect(unwrapVolatile(undefined)).toBeUndefined()
  })

  it('does not mistake a plain object for a live reference', () => {
    const plain = { get: 'not a function' }
    expect(unwrapVolatile(plain)).toBe(plain)
  })

  it('peels nested references so a settings service can validate the object', () => {
    // The provider validates and structuredClones the WHOLE config; a surviving
    // reference anywhere inside it fails with "$.authFile expected string but
    // got [object Object]" and the namespace never registers.
    const config = {
      authFile: { get: () => '/tmp/auth.info' },
      creditReserves: { acc1: { get: () => 50 } },
      disabledAccountIds: [{ get: () => 'acc1' }],
      automation: { enabled: { get: () => true } },
      plain: 'kept',
    }
    expect(unwrapVolatileDeep(config)).toEqual({
      authFile: '/tmp/auth.info',
      creditReserves: { acc1: 50 },
      disabledAccountIds: ['acc1'],
      automation: { enabled: true },
      plain: 'kept',
    })
  })

  it('unwrapped output carries no function values', () => {
    const config = { a: { get: () => 'x' }, b: { nested: { get: () => 1 } } }
    const plain = unwrapVolatileDeep(config)
    const serialized = JSON.stringify(plain)
    expect(serialized).toBe('{"a":"x","b":{"nested":1}}')
  })
})

describe('the browser entry stays loadable on both lines', () => {
  it('injects only services both lines provide', () => {
    // Naming either mutually-exclusive settings service here is fatal: cordis
    // never runs apply for a fiber whose inject is unsatisfied.
    expect(clientSource).toContain("export const inject = ['slots', 'locale']")
    expect(clientSource).not.toMatch(/export const inject = \[[^\]]*configForms/)
    expect(clientSource).not.toMatch(/export const inject = \[[^\]]*settingsScope/)
  })

  it('reaches the settings service through the non-throwing probe', () => {
    // Property access on an undeclared service throws; ctx.get() returns
    // undefined. Touching ctx.configForms directly would reintroduce the crash.
    expect(clientSource).toContain("get(serviceName)")
    expect(clientSource).toContain("softGet('configForms')")
    expect(clientSource).toContain("softGet('settingsScope')")
    expect(clientSource).not.toMatch(/ctx\.configForms\./)
    expect(clientSource).not.toMatch(/ctx\.settingsScope\./)
  })

  it('registers into settings.section, not the 0.1.5-only plugin item slot', () => {
    // `settings.plugin.item` does not exist on 0.1.7, so registering there
    // silently shows no card; `settings.section` is the left-nav page both
    // lines declare (it is what Token Saver and the built-in pages use).
    expect(clientSource).toContain("ctx.slots.inject('settings.section'")
    expect(clientSource).not.toContain("'settings.plugin.item'")
  })

  it('keys the 0.1.7 form by the host entry id, and the 0.1.5 one by namespace', () => {
    // configForms.get() is addressed by the HOST entry id; settingsScope.bind()
    // by the namespace installSection registered. Swapping them binds the card
    // to a namespace nothing serves, so every save silently no-ops.
    expect(clientSource).toContain('WORKBUDDY_POOL_ENTRY_ID')
    expect(clientSource).toContain("WORKBUDDY_POOL_SETTINGS_NS")
    expect(clientSource).toContain("scope.bind({ namespace: WORKBUDDY_POOL_SETTINGS_NS })")
  })
})

describe('the settings page renders on both kernel lines', () => {
  it('renders the whole page with no collapse affordance', () => {
    // The card used to be a collapsible plugin-configuration row; inside a
    // dedicated settings page that fold only hid the pool behind a click, so
    // the whole body renders immediately.
    const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
    expect(card).not.toMatch(/\{open\s*$/)
    expect(card).not.toContain('setOpen')
    expect(card).not.toContain('aria-expanded')
    expect(card).not.toContain('dsm-plugin-card')
    // The body renders directly inside the page now, split into cards: one per
    // feature area, plus the status card that carries the region switch.
    expect(card).toContain('dsm-workbuddy-xdpool-page')
    expect(card).toMatch(/dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-status/)
    expect(card).toMatch(/dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-accounts/)
    expect(card).toMatch(/dsm-workbuddy-xdpool-card dsm-workbuddy-xdpool-models/)
  })

  it('polls while the page is mounted instead of while it is expanded', () => {
    // The old gate (`if (!open) return`) meant a collapsed page never fetched;
    // with no fold the effect must run on mount.
    const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
    expect(card).not.toMatch(/if \(!open\) return/)
    expect(card).toContain('}, [refresh, activeRegion])')
  })
  it('marks the nav row and masks the plugin glyph over the shell icon', () => {
    // `settings.section` projects only id / order / label — there is no icon
    // field — so the nav glyph has to be installed over the shell svg by
    // marking the row and masking artwork into it (what dshmarket does).
    const client = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(client).toContain('installNavIcon')
    expect(client).toContain('MutationObserver')
    expect(client).toContain('data-dsh-xdpool-nav-icon')
    expect(client).toContain("mask-image")
  })

  it('shows the short nav label in the settings column', () => {
    // The nav column is narrow, so the row uses a dedicated short label while
    // the card body keeps the full product name.
    const client = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(client).toContain("t('row.navLabel')")
    const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    const labels = locales.match(/'row\.navLabel': '([^']+)'/g) ?? []
    expect(labels.length).toBe(2)
    for (const line of labels) expect(line).toContain('XD Pool')
  })
})

describe('a failing earnings save must not take the host down', () => {
  /**
   * The bug this pins (community report): the scheduler called its async
   * persistence hook inside a `try` WITHOUT awaiting it. A `try` around a call
   * that is not awaited catches only synchronous throws — the rejection escapes
   * as an unhandled rejection, and the host installs `installFailLoud`, which
   * turns any unhandled rejection into `exit(1)`.
   *
   * The reporter saw the whole DSH process die on startup the moment the
   * settings page asked for a status document (which rolls the earnings ledger).
   * Renaming `set()` to `update()` fixed that specific throw, but the STRUCTURE
   * was still unsafe: any other save failure — a missing service, a locked file,
   * a rejected payload — would kill the host the same way.
   */
  it('swallows an async rejection from the persistence hook', async () => {
    const scheduler = new WorkBuddyScheduler(
      { acquire: async () => { throw new Error('unused') } } as unknown as WorkBuddyAccountPool,
      {} as unknown as WorkBuddyUpstreamClient,
      { logger: { warn: () => {} } },
    )

    let unhandled: unknown
    const onUnhandled = (error: unknown): void => { unhandled = error }
    process.on('unhandledRejection', onUnhandled)
    try {
      // An async hook that rejects — exactly what the host-side settings write
      // does when the service is missing or the write is refused.
      scheduler.setEarningsPersistence(async () => {
        throw new Error('settings service has no update(); automationEarnings was not saved')
      })
      // Recording a take is what triggers a persist; a real value keeps the
      // write path on its normal route.
      ;(scheduler as unknown as { recordEarnings: (a: string, d: string, delta: object) => void })
        .recordEarnings('acc-1', dayKey(new Date()), { credit: 10 })

      // Give the microtask queue a turn: an unhandled rejection surfaces here.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('still surfaces a SYNCHRONOUS throw from the hook to the logger', async () => {
    // The sync path must keep working: a plain throw is caught and logged, not
    // rethrown into the caller (a failed save must never abort a run that has
    // already collected rewards).
    const warnings: unknown[][] = []
    const scheduler = new WorkBuddyScheduler(
      { acquire: async () => { throw new Error('unused') } } as unknown as WorkBuddyAccountPool,
      {} as unknown as WorkBuddyUpstreamClient,
      { logger: { warn: (...args: unknown[]) => { warnings.push(args) } } },
    )
    scheduler.setEarningsPersistence(() => { throw new Error('disk is full') })
    ;(scheduler as unknown as { recordEarnings: (a: string, d: string, delta: object) => void })
      .recordEarnings('acc-1', dayKey(new Date()), { credit: 5 })

    expect(warnings.length).toBeGreaterThan(0)
    expect(String(warnings[0]?.[0])).toMatch(/could not persist automation earnings/)
  })

  it('the persist hook is allowed to return a promise', () => {
    // Structural: the setter must accept an async hook, or the host-side
    // settings write could not be wired in at all.
    const schedulerSource = readFileSync(new URL('../src/scheduler.ts', import.meta.url), 'utf8')
    expect(schedulerSource).toMatch(/setEarningsPersistence\(save: \(ledger: AutomationLedger\) => void \| Promise<void>\)/)
    // And the persist site must attach a rejection handler to whatever the hook
    // returns — not merely wrap the call in a try.
    expect(schedulerSource).toMatch(/typeof saved\.then === .function./)
  })
})
