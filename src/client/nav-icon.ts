/**
 * Nav glyph for the WorkBuddy XD Pool settings page.
 *
 * The host's settings shell draws its own 16px `svg` in every nav row and the
 * `settings.section` registration contract projects only `id` / `order` /
 * `label` — there is no `icon` field to pass. A third-party page therefore has
 * to mark its row in the DOM and mask this artwork over the shell's glyph, the
 * same technique `dshmarket` uses (`installSettingsNavIcon`).
 *
 * Kept as a single monochrome path so `mask-image` + `currentColor` can tint it
 * with whatever the active theme uses for nav text: a filled mask cannot carry
 * its own palette, and a two-tone icon would render as a flat silhouette.
 *
 * @module dsh-workbuddy-xdpool/client/nav-icon
 */

/**
 * The nav mark: a stack of three rounded "accounts" under a rotation arc.
 *
 * Reads as "a pool of accounts being cycled" at 16px, and — unlike a literal
 * droplet or cloud — stays legible when reduced to a single-color silhouette.
 * `fill-rule="evenodd"` cuts the interior notches out of the silhouette so the
 * three layers stay distinguishable at that size.
 */
export const POOL_NAV_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">',
  // Three stacked account discs. evenodd keeps the gaps between them open so the
  // silhouette does not collapse into one blob when masked.
  '<path fill="currentColor" fill-rule="evenodd" d="',
  'M12 2.6a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 1.7a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z',
  'M6.6 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  'M17.4 8.9a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Zm0 1.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  '"/>',
  // Rotation arc: the "pool cycles between them" half of the mark.
  '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"',
  ' d="M4.4 17.2a8.6 8.6 0 0 0 15.2 0" stroke-dasharray="2.6 2.2"/>',
  '</svg>',
].join('')

/**
 * The same artwork as a `mask-image` URL.
 *
 * `encodeURIComponent` keeps the `#`-free markup safe inside a `url("…")` in a
 * stylesheet, and `currentColor` is resolved by the mask's own element rather
 * than by the SVG, so the glyph follows the theme.
 */
export const POOL_NAV_ICON_MASK_URL = `data:image/svg+xml;utf8,${encodeURIComponent(POOL_NAV_ICON_SVG)}`
