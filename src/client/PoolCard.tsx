/**
 * WorkBuddy XD Pool card contributed to DSH Plugin configuration.
 *
 * The card body mirrors the LaoDing plugin family used by dingminhua's
 * `dsh-connect-workbuddy`: a small status row (dot + count + Rescan / Clear
 * cooldowns buttons), then a per-account panel showing label / status tag /
 * token expiry / cooldown info / credit packages, then the model directory
 * with per-model free/limited/night/image badges and context size.
 *
 * The outer shell reuses the host's `dsm-plugin-card*` classes so the
 * collapse affordance is identical to every other plugin configuration row.
 *
 * @module dsh-workbuddy-xdpool/client/PoolCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  POOL_RESET_COOLDOWN_PATH,
  POOL_RESCAN_PATH,
  POOL_STATUS_PATH,
  type PoolWebAccount,
  type PoolWebModel,
  type PoolWebStatus,
} from '../status-paths.ts'
import { POOL_PLUGIN_ICON } from './icon.ts'
import { POOL_CARD_CSS } from './styles.ts'
import type { WorkBuddyPoolSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface PoolCardInjected {
  t: (key: WorkBuddyPoolSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type PoolCardProps = PropsRuntime<'settings.plugin.item'> & Partial<PoolCardInjected>

const POLL_INTERVAL_MS = 30_000

/** Inject or refresh the shared card CSS for the current client bundle. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-workbuddy-xdpool/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = POOL_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-workbuddy-xdpool'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = POOL_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return '–'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatDateTime(value: string | undefined): string {
  if (value === undefined) return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms))
}

function dotColor(status: 'ok' | 'error' | 'idle'): string {
  return status === 'ok'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #ef4444)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
}

function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/** Pick the right promotion chip for a model. */
function tagFor(model: PoolWebModel): 'free' | 'limited' | 'night' | undefined {
  const tags = model.tags ?? []
  if (tags.includes('free')) return 'free'
  if (tags.includes('limited-free')) return 'limited'
  if (tags.includes('night-discount')) return 'night'
  return undefined
}

/** Render pool health, per-account credits/cooldown, and the model directory. */
export function PoolCard({ t }: PoolCardProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<PoolWebStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [cooldownBusy, setCooldownBusy] = useState(false)
  const [flash, setFlash] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(`${POOL_STATUS_PATH}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (mounted.current && signal?.aborted !== true) {
        setStatus(value as PoolWebStatus)
        setError(undefined)
      }
    } catch (cause: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_RESCAN_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      const body = await response.json() as { accounts?: number; error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      await refresh()
      if (mounted.current) setFlash(t?.('row.accountsRescanned', { count: body.accounts ?? 0 }) ?? '')
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const resetCooldowns = async (): Promise<void> => {
    setCooldownBusy(true)
    setFlash(undefined)
    try {
      const response = await fetch(POOL_RESET_COOLDOWN_PATH, {
        method: 'POST', headers: { accept: 'application/json' }, credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh()
      if (mounted.current) setFlash(t?.('row.resetCooldownsDone') ?? '')
    } catch (cause: unknown) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setCooldownBusy(false)
    }
  }

  const title = t?.('row.title') ?? 'WorkBuddy XD Pool'
  const description = t?.('row.desc') ?? ''
  const accountCount = status?.accounts.length ?? 0
  const cooling = status?.cooling ?? 0
  const idle = status === undefined && error === undefined
  const hasHealthy = accountCount > 0 && cooling < accountCount
  const state: 'ok' | 'error' | 'idle' = error !== undefined
    ? 'error'
    : (idle ? 'idle' : (hasHealthy ? 'ok' : 'idle'))
  const stateLabel = error !== undefined
    ? (t?.('row.requestFailed') ?? 'Request failed')
    : accountCount === 0
      ? (t?.('row.poolEmpty') ?? 'No account yet')
      : state === 'ok'
        ? (t?.('row.ok') ?? 'Healthy')
        : (t?.('row.allCooling') ?? 'All cooling')
  const shimRunning = status?.shim.running === true
  const shimHint = status === undefined
    ? null
    : shimRunning
      ? `${t?.('row.shimRunning') ?? 'Provider listening'}${status.shim.baseUrl === undefined ? '' : ` · ${status.shim.baseUrl}`}`
      : (t?.('row.shimStopped') ?? 'Provider loopback not running')

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        aria-expanded={open}
        aria-label={`${t?.(open ? 'row.collapse' : 'row.expand') ?? ''}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <img className="dsm-plugin-card-icon" src={POOL_PLUGIN_ICON} alt="" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{title}</span>
          <span className="dsm-plugin-card-description">{description}</span>
        </span>
        <span
          aria-hidden="true"
          className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`}
        >
          {h(IconChevronDownOutline14, { size: 14 })}
        </span>
      </button>
      {open
        ? <div className="dsm-plugin-card-body">
            <div className="dsm-workbuddy-xdpool-usage">
              <div className="dsm-workbuddy-xdpool-usage-head">
                <div className="dsm-workbuddy-xdpool-usage-copy" role="status">
                  <div className="dsm-workbuddy-xdpool-usage-status">
                    <span
                      aria-hidden="true"
                      className="dsm-workbuddy-xdpool-usage-dot"
                      style={{ background: dotColor(state) }}
                    />
                    <span>{stateLabel}</span>
                  </div>
                  {accountCount > 0
                    ? <p className="dsm-workbuddy-xdpool-usage-hint">
                        {t?.('row.accountsSummary', { count: accountCount, cooling })
                          ?? `${accountCount} account(s) · ${cooling} cooling`}
                      </p>
                    : null}
                  {shimHint === null ? null
                    : <p className="dsm-workbuddy-xdpool-usage-hint">{shimHint}</p>}
                </div>
                <div className="dsm-workbuddy-xdpool-usage-actions">
                  <button
                    type="button"
                    className="dsm-btn dsm-btn-outline"
                    disabled={busy}
                    onClick={() => { void rescan() }}
                  >
                    {busy
                      ? (t?.('row.accountsScanning') ?? 'Detecting…')
                      : (t?.('row.accountsRescan') ?? 'Detect accounts again')}
                  </button>
                  {cooling > 0
                    ? <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        disabled={cooldownBusy}
                        onClick={() => { void resetCooldowns() }}
                      >
                        {cooldownBusy
                          ? (t?.('row.resetCooldownsBusy') ?? 'Clearing…')
                          : (t?.('row.resetCooldowns') ?? 'Clear all cooldowns')}
                      </button>
                    : null}
                </div>
              </div>

              {flash === undefined ? null
                : <p className="dsm-workbuddy-xdpool-note">{flash}</p>}
              {error === undefined ? null
                : <p className="dsm-workbuddy-xdpool-error">
                    {t?.('row.error', { message: error }) ?? `Pool status unavailable: ${error}`}
                  </p>}

              {accountCount === 0 && error === undefined
                ? <p className="dsm-workbuddy-xdpool-note">{t?.('row.poolEmptyHint') ?? ''}</p>
                : null}

              {accountCount > 0
                ? <section className="dsm-workbuddy-xdpool-accounts" aria-label={t?.('row.accountsTitle') ?? 'Accounts'}>
                    <div className="dsm-workbuddy-xdpool-accounts-head">
                      <h3 className="dsm-workbuddy-xdpool-accounts-title">
                        {t?.('row.accountsTitle') ?? 'Accounts in the pool'}
                      </h3>
                      <p className="dsm-workbuddy-xdpool-accounts-summary">
                        {t?.('row.accountsSummary', { count: accountCount, cooling })
                          ?? `${accountCount} account(s) · ${cooling} cooling`}
                      </p>
                    </div>
                    {status?.accounts.map(account => (
                      <AccountBlock
                        key={account.id}
                        account={account}
                        {...status.activeAccountId === undefined ? {} : { activeAccountId: status.activeAccountId }}
                        t={t}
                      />
                    ))}
                  </section>
                : null}

              {(status?.models.length ?? 0) > 0
                ? <section className="dsm-workbuddy-xdpool-models" aria-label={t?.('row.modelsTitle') ?? 'Models'}>
                    <div className="dsm-workbuddy-xdpool-models-head">
                      <h3 className="dsm-workbuddy-xdpool-models-title">
                        {t?.('row.modelsTitle') ?? 'Models'}
                      </h3>
                      <p className="dsm-workbuddy-xdpool-models-summary">
                        {t?.('row.modelsSummary', { count: status?.models.length ?? 0 })
                          ?? `${status?.models.length ?? 0} model(s) in the live catalog`}
                      </p>
                    </div>
                    <div className="dsm-workbuddy-xdpool-model-list">
                      {status?.models.map(model => (
                        <ModelRow key={model.id} model={model} t={t} />
                      ))}
                    </div>
                  </section>
                : null}
            </div>
          </div>
        : null}
    </li>
  )
}

/** One account block: label + status tag + meta + optional credit panels. */
function AccountBlock({
  account,
  activeAccountId,
  t,
}: {
  account: PoolWebAccount
  activeAccountId?: string
  t?: PoolCardProps['t']
}) {
  const isActive = account.id === activeAccountId
  const isCooling = account.cooling === true
  const cooldownUntil = account.cooldownUntil !== undefined ? Date.parse(account.cooldownUntil) : undefined
  const modelCooldowns = account.modelCooldowns ?? []

  // A whole-account cooldown shows the "Cooling" tag; per-model cooldowns do
  // NOT mark the account cooling (its other models still serve) — they render
  // as small per-model chips instead, e.g. "hy4-preview cooling to 10:14".
  const tag = isActive
    ? { text: t?.('row.accountNext') ?? 'Next up', cls: 'dsm-workbuddy-xdpool-account-tag' }
    : isCooling
      ? { text: t?.('row.cooling') ?? 'Cooling', cls: 'dsm-workbuddy-xdpool-account-tag dsm-workbuddy-xdpool-account-tag-cooling' }
      : null

  return (
    <div className="dsm-workbuddy-xdpool-account">
      <div className="dsm-workbuddy-xdpool-account-copy">
        <span className="dsm-workbuddy-xdpool-account-label">{account.label}</span>
        <div className="dsm-workbuddy-xdpool-account-tags">
          {tag === null ? null : <span className={tag.cls}>{tag.text}</span>}
        </div>
        {account.domain !== '' && <span className="dsm-workbuddy-xdpool-account-meta">{account.domain}</span>}
        {account.expiresAt !== undefined
          ? <span className="dsm-workbuddy-xdpool-account-meta">
              {t?.('row.tokenExpiry', { time: formatDateTime(account.expiresAt) })
                ?? `token ${formatDateTime(account.expiresAt)}`}
            </span>
          : null}
        {isCooling && cooldownUntil !== undefined && !Number.isNaN(cooldownUntil)
          ? <span className="dsm-workbuddy-xdpool-account-meta">
              {t?.('row.cooldownUntil', { time: formatTime(cooldownUntil) }) ?? `until ${formatTime(cooldownUntil)}`}
              {' · '}
              {t?.('row.cooldownHits', { hits: account.rateLimitHits ?? 0 })
                ?? `${account.rateLimitHits ?? 0} hit(s)`}
            </span>
          : null}
        {modelCooldowns.length > 0
          ? <div className="dsm-workbuddy-xdpool-account-modelcool">
              {modelCooldowns.map(mc => (
                <span key={mc.modelId} className="dsm-workbuddy-xdpool-account-modelcool-chip">
                  {t?.('row.modelCooling', { model: mc.modelId, time: formatDateTime(mc.until) })
                    ?? `${mc.modelId} cooling to ${formatDateTime(mc.until)}`}
                </span>
              ))}
            </div>
          : null}
      </div>
      {account.credits === undefined && account.creditsError === undefined ? null
        : <AccountCredits account={account} t={t} />}
    </div>
  )
}

/** Two-panel credit layout: package list on the left, big total on the right. */
function AccountCredits({ account, t }: { account: PoolWebAccount; t?: PoolCardProps['t'] }) {
  if (account.creditsError !== undefined) {
    return (
      <p className="dsm-workbuddy-xdpool-account-error">
        {t?.('row.creditsError', { message: account.creditsError }) ?? account.creditsError}
      </p>
    )
  }
  const credits = account.credits
  if (credits === undefined) return null
  const packages = credits.packages.filter(p => (p.size ?? 0) > 0).slice(0, 5)

  return (
    <div className="dsm-workbuddy-xdpool-credits-panels">
      <div className="dsm-workbuddy-xdpool-credit-panel">
        <span className="dsm-workbuddy-xdpool-credit-panel-title">
          {t?.('row.creditsPackages') ?? 'Credit packages'}
        </span>
        {packages.length === 0
          ? <span className="dsm-workbuddy-xdpool-credit-panel-value">–</span>
          : <ul className="dsm-workbuddy-xdpool-credit-packages">
              {packages.map((pack, index) => (
                <li key={`${pack.packageName}-${String(index)}`}>
                  <span>{pack.packageName}</span>
                  <span>
                    {t?.('row.creditsPackage', { remain: formatNumber(pack.remain), size: formatNumber(pack.size) })
                      ?? `${formatNumber(pack.remain)} / ${formatNumber(pack.size)}`}
                  </span>
                </li>
              ))}
            </ul>}
      </div>
      <div className="dsm-workbuddy-xdpool-credit-panel dsm-workbuddy-xdpool-credit-panel-total">
        <div className="dsm-workbuddy-xdpool-credit-total-body">
          <span className="dsm-workbuddy-xdpool-credit-panel-title">
            {t?.('row.creditsTotal') ?? 'Total'}
          </span>
          <span className="dsm-workbuddy-xdpool-credit-total-value">
            {formatNumber(credits.total)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** One model row: name + rate + tag chip + image badge + context size. */
function ModelRow({ model, t }: { model: PoolWebModel; t?: PoolCardProps['t'] }) {
  const tag = tagFor(model)
  const tagText = tag === 'free'
    ? (t?.('row.free') ?? 'free')
    : tag === 'limited'
      ? (t?.('row.limitedFree') ?? 'limited free')
      : tag === 'night'
        ? (t?.('row.nightDiscount') ?? 'night')
        : null

  return (
    <div className="dsm-workbuddy-xdpool-model">
      <div className="dsm-workbuddy-xdpool-model-head">
        <div className="dsm-workbuddy-xdpool-model-copy">
          <span className="dsm-workbuddy-xdpool-model-name">
            <span>{model.name}</span>
            {model.multiplier === undefined ? null
              : <span className="dsm-workbuddy-xdpool-model-name-rate">
                  {t?.('row.rate', { rate: model.multiplier.toFixed(2) }) ?? `${model.multiplier.toFixed(2)}x`}
                </span>}
          </span>
          <span className="dsm-workbuddy-xdpool-model-id">{model.id}</span>
        </div>
        <div className="dsm-workbuddy-xdpool-model-meta">
          {tagText === null ? null
            : <span className="dsm-workbuddy-xdpool-model-meta-tag">{tagText}</span>}
          {model.supportsImages === true
            ? <span className="dsm-workbuddy-xdpool-model-meta-tag">
                {t?.('row.imageCapable') ?? 'image'}
              </span>
            : null}
          {model.contextWindow === undefined ? null
            : <span className="dsm-workbuddy-xdpool-model-cap">
                {formatCapacity(model.contextWindow)}
              </span>}
        </div>
      </div>
    </div>
  )
}