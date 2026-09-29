/**
 * Model catalog with per-model credit multipliers.
 *
 * A static fallback keeps the provider usable before the first successful
 * upstream call; when the live catalog arrives it replaces the fallback and
 * the adapter rebuilds the provider's model list.
 *
 * @module dsh-workbuddy-xdpool/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.ts'
import type { PoolWebCatalogSource } from './status-paths.ts'

/** One model the provider exposes. */
export interface WorkBuddyModelInfo {
  id: string
  /** Display name; the multiplier is appended for the picker. */
  name: string
  contextWindow: number
  maxOutputTokens: number
  /** Relative credit cost, e.g. 0.79 for `x0.79`. */
  multiplier?: number
  /** Upstream-declared thinking levels. */
  supportedEfforts?: readonly string[]
  supportsImages: boolean
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[]
}

/**
 * Static fallback used before the first live catalog fetch, and whenever the
 * upstream cannot be reached.
 *
 * This table is the DOMESTIC (CN) roster, and it is kept in step with what
 * `copilot.tencent.com` actually advertises. It matters more than a "just in
 * case" list usually would: a failed startup fetch falls back to it, and the
 * user sees that as "half my models were deleted" — `deepseek-v4.1-flash`
 * and friends simply vanishing from the picker, with no visible explanation.
 *
 * Every row below was captured from the live endpoint, INCLUDING the window
 * sizes: the previous version carried a 32K window for `hy3` when the gateway
 * says 192K, and listed `kimi-k3` under an id the gateway no longer uses
 * (`kimi-k3-1`). A stale fallback is worse than a short one — it looks
 * authoritative while being wrong.
 *
 * `multiplier: 0` is the gateways' own spelling of "free" (`credits: "x0.00"`),
 * which is what turns on the free badge.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.29 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0 },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.05 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.11 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.51 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.79 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, multiplier: 0.06 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.79 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxOutputTokens: 48_000, supportsImages: false, multiplier: 0.79 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.71 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 1.62 },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.77 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.57 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.52 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.25 },
]

/** Live catalog with a static fallback behind it. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS
  private listeners = new Set<() => void>()
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection: ModelSelection = {}
  /**
   * Whether `models` came from the gateway or from the static table.
   *
   * Tracked so the card can SAY which it is showing. A failed fetch used to be
   * invisible on screen: the picker simply held fewer models than before, which
   * the user reasonably read as "the plugin deleted my models" rather than "the
   * network hiccuped at startup".
   */
  private source: PoolWebCatalogSource = 'fallback'
  /** When the live list last landed. */
  private lastUpdatedAt: string | undefined
  /** Why the last fetch failed, for display. */
  private lastError: string | undefined

  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /**
   * The models DSH should actually offer, after applying the user's selection:
   * disabled models are dropped, an explicit image list overrides the upstream
   * capability flag, and a per-model budget caps the advertised window.
   *
   * An absent `enabledModelIds` means "everything" — a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible(): readonly WorkBuddyModelInfo[] {
    const enabled = this.selection.enabledModelIds
    const allow = enabled === undefined ? undefined : new Set(enabled)
    const images = this.selection.imageModelIds
    const imageSet = images === undefined ? undefined : new Set(images)
    const budgets = this.selection.contextBudgets
    return this.models
      .filter(model => allow === undefined || allow.has(model.id))
      .map(model => {
        const next = { ...model }
        if (imageSet !== undefined) next.supportsImages = next.supportsImages || imageSet.has(model.id)
        const budget = budgets?.[model.id]
        if (budget !== undefined && budget > 0 && budget < next.contextWindow) next.contextWindow = budget
        return next
      })
  }

  /** Replace the catalog and notify the adapter to rebuild its model list. */
  update(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) return
    this.models = models
    this.notify()
  }

  /** Restore the static fallback, e.g. when the upstream stops answering. */
  reset(): void {
    this.models = FALLBACK_WORKBUDDY_MODELS
    this.source = 'fallback'
    this.notify()
  }

  /** Replace the user's selection; the adapter rebuilds from `visible()`. */
  applySelection(selection: ModelSelection): void {
    this.selection = selection
    this.notify()
  }

  /** The selection currently in force, for the card's save round-trip. */
  currentSelection(): ModelSelection {
    return this.selection
  }

  /**
   * Whether this catalog is serving live data or the built-in table.
   *
   * `fallback` is not an error state, but it IS a degraded one: the user is
   * looking at a shorter roster than the gateway offers, so the card says so
   * and offers a retry instead of letting them wonder where the models went.
   */
  currentSource(): PoolWebCatalogSource {
    return this.source
  }

  /**
   * When the live list last landed, if it ever did.
   *
   * Named `catalogUpdatedAt()` rather than `updatedAt()` because the class
   * already had an `updatedAt` member; two members of the same name is a
   * compile error, and the awkwardness is a useful signal that the concept is
   * "when THIS catalog was refreshed", not a generic timestamp.
   */
  catalogUpdatedAt(): string | undefined {
    return this.lastUpdatedAt
  }

  /** Why the last fetch failed, if it did. */
  lastFetchError(): string | undefined {
    return this.lastError
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  find(id: string): WorkBuddyModelInfo | undefined {
    return this.models.find(model => model.id === id)
  }

  /** Replace the catalog from the live upstream list; keeps the fallback if empty. */
  updateFromUpstream(models: readonly WorkBuddyUpstreamModel[]): void {
    this.update(catalogFromUpstream(models))
    this.source = 'live'
    this.lastUpdatedAt = new Date().toISOString()
    this.lastError = undefined
  }

  /**
   * Record that a fetch attempt failed, leaving the current list in place.
   *
   * The list is deliberately NOT reset here: a refresh that fails should keep
   * whatever working catalog is already loaded, rather than demoting a healthy
   * session to the static table because one retry ran out.
   */
  noteFetchFailure(message: string): void {
    this.lastError = message
    // Only report `fallback` when that is actually what we are showing: a live
    // list that merely failed to REFRESH is still live.
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The user's model selection, as stored in the settings section. */
export interface ModelSelection {
  /** Absent = every model in the catalog is offered. */
  enabledModelIds?: readonly string[]
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[]
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/** Convert one upstream catalog entry into the plugin's model-info shape. */
export function toModelInfo(model: WorkBuddyUpstreamModel): WorkBuddyModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsImages: model.supportsImages ?? false,
    ...model.creditMultiplier === undefined ? {} : { multiplier: model.creditMultiplier },
    ...model.reasoning?.supportedEfforts === undefined ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
    // `tags` used to be dropped here as well, so even a gateway that DID send
    // `free` would have had it stripped before the card ever saw it.
    ...model.tags === undefined || model.tags.length === 0 ? {} : { tags: model.tags },
  }
}

/** Map the live upstream list, falling back to the static list when empty. */
export function catalogFromUpstream(models: readonly WorkBuddyUpstreamModel[]): readonly WorkBuddyModelInfo[] {
  if (models.length === 0) return FALLBACK_WORKBUDDY_MODELS
  return models.map(toModelInfo)
}
