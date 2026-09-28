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

/**
 * International (global) fallback, used before the first live `/v3/config`
 * fetch and whenever the overseas gateway is unreachable.
 *
 * The two gateways advertise DIFFERENT rosters and different model ids, so the
 * CN list above is the wrong fallback for the international tab — it drops
 * GPT/Grok/Gemini and invents models the global gateway has never served
 * (`deepseek-v4-pro`/`deepseek-v4-flash`/`minimax-m3`), which is exactly the
 * "国际版模型完全不对" symptom. This list mirrors the real `/v3/config` roster
 * that `fetchModels` parses (same ids, names and multipliers), so a region that
 * has not yet fetched a live catalog still shows the right models. Media models
 * (`gpt-image-*`, `seedance-*`) are intentionally excluded: they carry no token
 * limits upstream and would otherwise render as text-only chat models.
 */
export const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxOutputTokens: 24_000, supportsImages: true },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxOutputTokens: 72_000, supportsImages: true, multiplier: 3.31 },
  { id: 'deep-model', name: 'Ultimate', contextWindow: 176_000, maxOutputTokens: 24_000, supportsImages: true, multiplier: 3.33 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.29 },
  { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 6.67 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxOutputTokens: 72_000, supportsImages: true, multiplier: 1.65 },
  { id: 'grok-4.7', name: 'Grok-4.7', contextWindow: 500_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 1.9 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true, multiplier: 0.99 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.06 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 48_000, supportsImages: true, multiplier: 0.79 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 48_000, supportsImages: true, multiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 1.62 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.52 },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.77 },
]

/** Live catalog with a static fallback behind it. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[]
  /** The fallback this catalog reverts to; region-specific (CN vs global). */
  private readonly fallback: readonly WorkBuddyModelInfo[]

  constructor(fallback: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS) {
    this.models = fallback
    this.fallback = fallback
  }
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
    this.models = this.fallback
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
    this.update(catalogFromUpstream(models, this.fallback))
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
export function catalogFromUpstream(
  models: readonly WorkBuddyUpstreamModel[],
  fallback: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS,
): readonly WorkBuddyModelInfo[] {
  if (models.length === 0) return fallback
  return models.map(toModelInfo)
}
