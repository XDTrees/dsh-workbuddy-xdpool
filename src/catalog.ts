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
 * The multipliers are carried on purpose. Without them the provider's model
 * picker silently loses every rate and every free badge the moment the live
 * fetch fails — which reads to the user as "the plugin broke my model list"
 * rather than "the upstream is unreachable". The values are the ones the two
 * gateways actually advertise for these ids (`credits: "x0.79 credits"` and so
 * on), so a fallback row looks the same as a live one.
 *
 * `multiplier: 0` is the gateways' own spelling of "free" (`credits: "x0.00"`),
 * which is what turns on the free badge.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.79 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.06 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.79 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: false },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 1.62 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'hy3', name: 'Hy3', contextWindow: 32_000, maxOutputTokens: 8_000, supportsImages: true, multiplier: 0 },
  { id: 'hy4-preview', name: 'Hy4-Preview', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.29 },
]

/** Live catalog with a static fallback behind it. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS
  private listeners = new Set<() => void>()
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection: ModelSelection = {}

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
