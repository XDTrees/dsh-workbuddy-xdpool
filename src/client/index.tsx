/**
 * Browser half: WorkBuddy XD Pool health and model directory inside Plugin
 * configuration.
 *
 * Follows the same browser-plugin registration shape as the single-account
 * connector cards: `slots` / `locale` / `settingsScope` are injected, the copy
 * is registered under a locale namespace, and the whole `apply` body is
 * wrapped in try/catch so a slot-API change degrades to a console.error
 * instead of tripping the host's "Failed to load plugins" banner.
 *
 * @module dsh-workbuddy-xdpool/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PoolCard } from './PoolCard.tsx'
import type { PoolCardInjected } from './PoolCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy XD Pool card copy. Namespaced `settings.<WORKBUDDY_POOL_SETTINGS_NS>`. */
    'settings.workbuddy-xdpool': WorkBuddyPoolSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-xdpool-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register card copy and the pool card under Plugin configuration. */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy-xdpool'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-xdpool: settings copy')
    const t = ctx.locale.bind(namespace) as PoolCardInjected['t']
    // The model-selection controls write through this scope, so the card
    // must hold the same settings section the host installed. Without it the
    // rows would render read-only even when the profile is writable.
    const settingsScope = ctx.settingsScope.bind({ namespace: 'workbuddy-xdpool' }) as NonNullable<PoolCardInjected['settingsScope']>
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'workbuddy-xdpool',
      priority: 30,
      inject: (): PoolCardInjected => ({ t, settingsScope }),
    }, PoolCard))
  } catch (error: unknown) {
    // Degrade silently on the page: the pool provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-xdpool] client card failed to load (host provider unaffected):', error)
  }
}
