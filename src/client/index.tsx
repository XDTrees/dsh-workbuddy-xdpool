/**
 * Browser half: WorkBuddy XD Pool health and model directory, mounted as its
 * own page in the Settings panel's left nav.
 *
 * Registration shape (see the NOTE below — the choice of slot and of injected
 * services is what decides whether this half loads at all):
 *
 *  - `inject` names ONLY services that exist on BOTH host lines. Cordis' gate
 *    is hard: an inject entry the running line does not provide keeps `apply`
 *    from ever running, and the entry stays PENDING forever, so the Desktop
 *    reports "renderer boot failed (plugins: dsh-workbuddy-xdpool)" and refuses
 *    to open. `settingsScope` (0.1.5) and `configForms` (0.1.7) are mutually
 *    exclusive names for the same idea, so neither may be named here; whichever
 *    exists is reached through `ctx.get()` inside `apply`.
 *  - The page registers into `settings.section`, which BOTH lines declare and
 *    which is what puts a row in the Settings panel's left nav — the same slot
 *    the built-in General/Models/Plugins pages use. The old
 *    `settings.plugin.item` seat this plugin used is 0.1.5-only: it does not
 *    exist on 0.1.7 at all, so registering there silently showed no card.
 *
 * The whole body stays inside try/catch so a slot-API change degrades to a
 * console.error instead of tripping the host's "Failed to load plugins" banner.
 *
 * @module dsh-workbuddy-xdpool/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The settings.section SlotMap key is declared by the host's settings shell
// (@deepseek-ai/dsh-client-ui-settings), which is a host-supplied peer and is
// NOT a build dependency here: pinning it would make this bundle's typings
// follow one host line and break the other. The two seats this file touches
// (slots, locale) are declared by the packages imported below, and the
// section registration is narrowed locally at its call site.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PoolCard } from './PoolCard.tsx'
import { POOL_NAV_ICON_MASK_URL } from './nav-icon.ts'
import type { PoolCardInjected } from './PoolCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy XD Pool card copy. Namespaced `settings.<WORKBUDDY_POOL_SETTINGS_NS>`. */
    'settings.workbuddy-xdpool': WorkBuddyPoolSettingsKey
  }

  interface SlotMap {
    /**
     * One settings page per list entry, rendered as a row in the Settings
     * panel's left nav. Declared by the host's settings shell
     * (`@deepseek-ai/dsh-client-ui-settings`), which is a host-supplied peer
     * rather than a dependency of this bundle — so the contract is restated
     * here to type the registration below against both host lines.
     */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

/**
 * The browser-plugin context this entry needs.
 *
 * `ClientContext` used to be re-exported by `@deepseek-ai/dsh-client-runtime/client`;
 * that package stopped at 0.1.1-rc.2, so it cannot serve as a type source for a
 * build that has to run on 0.1.7. The `slots` / `locale` seats the card touches
 * are declared by the client subpath modules imported above, and cordis' own
 * `Context` carries the `effect` fiber API.
 */
export type WorkBuddyClientContext = Context & {
  /** Slot registry face (augmented onto cordis' Context by the host client runtime). */
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  /** Locale binder face (same augmentation source). */
  locale: {
    register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-xdpool-client'

/**
 * Client services required by the settings page.
 *
 * Deliberately only the two services present on BOTH host lines. The settings
 * surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7 replaces it
 * with `configForms` — and cordis' dependency gate is hard: any inject entry the
 * running line does not provide keeps `apply` from ever running. Probing the one
 * that exists through `ctx.get()` (which returns undefined, never throws, for an
 * absent service) is what lets one build serve both lines.
 */
export const inject = ['slots', 'locale']

/** Settings namespace the host-side section registers (shared with the entry). */
const WORKBUDDY_POOL_SETTINGS_NS = 'workbuddy-xdpool'

/**
 * Host plugin entry id this bundle is mounted under in `cordis.patch.yml`.
 *
 * `configForms` is addressed by this id on the 0.1.7 line.
 */
const WORKBUDDY_POOL_ENTRY_ID = 'llm-workbuddy-xdpool'

/** Register card copy and the pool page under Settings. */
export function apply(ctx: WorkBuddyClientContext): void {
  try {
    const namespace = 'settings.workbuddy-xdpool'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-xdpool: settings copy')
    const t = ctx.locale.bind(namespace) as PoolCardInjected['t']

    // Soft service probe. Property access on an undeclared service THROWS
    // ("cannot get property X without inject") — `?.` guards null/undefined,
    // not a throwing getter — while `ctx.get()` returns undefined for an absent
    // service. Never touch `ctx.configForms` / `ctx.settingsScope` directly.
    const softGet = (serviceName: string): unknown =>
      (ctx as unknown as { get(name: string): unknown }).get(serviceName)

    const settingsScope = resolveSettingsScope(softGet)

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'workbuddy-xdpool',
      // Sorted after the built-in pages (General 0 / Models 10 / Plugins 15 /
      // presets 20 / market 40) so the pool sits with the other community
      // pages rather than pushing a first-party one down.
      order: 440,
      // A thunk, not the resolved string: the shell re-reads it on every
      // projection, so the nav row follows a locale change without this entry
      // re-registering.
      label: () => t('row.navLabel'),
      inject: (): Partial<PoolCardInjected> => settingsScope === undefined
        ? { t }
        : { t, settingsScope },
    }, PoolCard))

    // The registration contract projects only id / order / label, so there is no
    // icon field to pass: the shell paints its own 16px glyph in every nav row
    // (a gear for an id it does not know). Mark the row in the DOM and mask this
    // artwork over the gear — the same technique dshmarket uses, and the only
    // route available to a third-party page.
    installNavIcon(ctx, () => t('row.navLabel'))
  } catch (error: unknown) {
    // Degrade silently on the page: the pool provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-xdpool] client page failed to load (host provider unaffected):', error)
  }
}

/** Attribute carrying the nav-row marker this module installs. */
const NAV_ICON_MARKER = 'data-dsh-xdpool-nav-icon'

/**
 * The settings nav rows, as the shell renders them. Scoped to the settings
 * dialog on purpose: the main sidebar has its own nav, and matching rows there
 * would stamp this glyph onto an unrelated control.
 */
const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

/**
 * Draw this page's own glyph in its Settings nav row.
 *
 * The `settings.section` contract carries no icon: the shell decides the glyph
 * from the section id and falls back to a gear for anything it does not know.
 * So the row is matched by its LABEL (the same thunk passed to the
 * registration, re-read on every pass so a locale switch is followed) and
 * marked; CSS then hides the shell svg and masks this artwork into the row.
 *
 * Re-scanned on DOM mutations because the shell re-renders the nav on locale
 * and theme changes, which replaces the row elements and drops the marker.
 *
 * No-op off the browser (the node-side probe imports this module for types).
 */
function installNavIcon(ctx: WorkBuddyClientContext, resolveLabel: () => string): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-workbuddy-xdpool'
    tag.dataset.pluginCss = 'dsh-workbuddy-xdpool/settings-nav-icon'
    tag.textContent = [
      `[${NAV_ICON_MARKER}] > svg { display: none; }`,
      `[${NAV_ICON_MARKER}]::before {`,
      "  content: '';",
      '  flex: none;',
      '  width: 16px;',
      '  height: 16px;',
      '  background-color: currentColor;',
      `  -webkit-mask-image: url("${POOL_NAV_ICON_MASK_URL}");`,
      `  mask-image: url("${POOL_NAV_ICON_MASK_URL}");`,
      '  -webkit-mask-repeat: no-repeat;',
      '  mask-repeat: no-repeat;',
      '  -webkit-mask-position: center;',
      '  mask-position: center;',
      '  -webkit-mask-size: 16px 16px;',
      '  mask-size: 16px 16px;',
      '}',
    ].join('\n')
    document.head.appendChild(tag)

    let disposed = false
    let scheduled = false
    const sync = (): void => {
      scheduled = false
      if (disposed) return
      const wanted = String(resolveLabel() ?? '').trim()
      if (wanted === '') return
      for (const row of document.querySelectorAll(NAV_ROW_SELECTOR)) {
        if (String(row.textContent ?? '').trim() === wanted) row.setAttribute(NAV_ICON_MARKER, '')
        else row.removeAttribute(NAV_ICON_MARKER)
      }
    }
    const schedule = (): void => {
      if (scheduled || disposed) return
      scheduled = true
      queueMicrotask(sync)
    }
    sync()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
      disposed = true
      observer.disconnect()
      for (const row of document.querySelectorAll(`[${NAV_ICON_MARKER}]`)) row.removeAttribute(NAV_ICON_MARKER)
      tag.remove()
    }
  }, 'dsh-workbuddy-xdpool: settings nav icon')
}

/**
 * Bind the settings form the card reads and writes, on whichever line is
 * running.
 *
 * 0.1.7 exposes `configForms.get(entryId)`, keyed by the HOST plugin entry id —
 * the id this bundle registers under in `cordis.patch.yml`, not the settings
 * namespace. 0.1.5 exposes `settingsScope.bind({ namespace })`, keyed by the
 * namespace the host-side `installSection` registered. Both controllers answer
 * the same two methods the card uses (`getSnapshot()`, `set(field, value)`), so
 * the card needs no per-line branch of its own.
 *
 * Returns undefined when neither service is present (a locked-down host): the
 * card then renders read-only, which is the documented degradation.
 */
function resolveSettingsScope(
  softGet: (serviceName: string) => unknown,
): PoolCardInjected['settingsScope'] | undefined {
  // 0.1.7 line. The entry id is host-chosen (the profile patch may mount this
  // plugin as `dsh-workbuddy-xdpool` or, as the live Desktop host does, as
  // `include:dsh-workbuddy-xdpool`), so ask the mirror which namespace it
  // serves rather than assuming a name: the host resolves a provider's
  // namespace by exact match, so guessing wrong binds the card to a namespace
  // nothing serves and every save silently no-ops.
  const forms = softGet('configForms') as {
    describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
    get(ns: string): PoolCardInjected['settingsScope']
  } | undefined
  if (forms !== undefined) {
    let entryId = WORKBUDDY_POOL_ENTRY_ID
    try {
      const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
      const served = namespaces.find(entry => entry.ns === WORKBUDDY_POOL_ENTRY_ID)
        ?? namespaces.find(entry => /workbuddy-xdpool/.test(entry.ns))
      if (served !== undefined) entryId = served.ns
    } catch {
      // Mirror not ready: the declared entry id is still the right answer.
    }
    return forms.get(entryId)
  }

  // 0.1.5 line.
  const scope = softGet('settingsScope') as {
    bind(spec: { namespace: string }): PoolCardInjected['settingsScope']
  } | undefined
  if (scope !== undefined) return scope.bind({ namespace: WORKBUDDY_POOL_SETTINGS_NS })

  return undefined
}
