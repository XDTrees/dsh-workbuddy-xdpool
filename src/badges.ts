/**
 * Promotion badges the upstream attaches to a model.
 *
 * Its own module because THREE callers need it and they cannot share one file:
 * `upstream.ts` (server, does the fetching), `adapter.ts` (server, builds the
 * model-picker display name) and `client/PoolCard.tsx` (browser bundle). The
 * card cannot import `upstream.ts` — that would drag the whole HTTP client into
 * the browser bundle — so if each side sniffed `badge:` on its own the three
 * would drift apart, which is exactly the bug this replaces.
 *
 * Why the parsing is needed at all: the promo vocabulary this plugin used to
 * expect (`free` / `limited-free` / `night-discount`) is NEVER sent by either
 * gateway. The CN roster instead declares promotions as
 *
 *     "badge:限时免费:#FF0000"   "badge:夜间免费:#FF0000"   "badge:夜间折扣:#1E90FF"
 *
 * i.e. a label plus a hex colour, both gateway-authored. Every one of those
 * declarations used to be parsed and then silently dropped, so the models
 * carrying them rendered exactly like plain paid rows.
 *
 * The label is kept VERBATIM from the upstream instead of being mapped to
 * English keys on the way through: it is already the string a user should read,
 * and a lookup table here would rot the moment the gateway rewords a badge.
 *
 * Note what is deliberately NOT here: a free-until date. The badge carries a
 * label and a colour, never an expiry, so the plugin can say "限时免费" but
 * cannot say when it ends. Inventing a date would change what the user spends.
 *
 * @module dsh-workbuddy-xdpool/badges
 */

/** Prefix the CN gateway uses for a promotion badge inside `tags`. */
export const BADGE_TAG_PREFIX = 'badge:'

/**
 * The one badge label that means "free right now".
 *
 * A name check rather than a position check, so a gateway that reorders or adds
 * other badges keeps working.
 */
const BADGE_FREE_LABEL = '限时免费'

/** One promotion badge the upstream attached, split into its two halves. */
export interface WorkBuddyBadge {
  /** The upstream's own label, e.g. `限时免费`. */
  label: string
  /** The `#RRGGBB` the upstream asked for, when it supplied one. */
  color?: string
}

/** A `#`-prefixed hex colour of 3–8 digits, which is what CSS accepts. */
const COLOR_TAIL = /^[0-9A-Fa-f]{3,8}$/

/**
 * Split the `badge:<label>:#RRGGBB` entries the CN gateway puts in `tags`.
 *
 * `#` may legitimately occur inside a label, so the split happens on the LAST
 * one and the tail is only accepted as a colour when it actually looks like
 * one — otherwise a label such as `C#` would silently lose its last character.
 *
 * Returns an empty array for `undefined` so callers can iterate unconditionally.
 */
export function parseBadgeTags(tags: readonly string[] | undefined): readonly WorkBuddyBadge[] {
  const out: WorkBuddyBadge[] = []
  for (const tag of tags ?? []) {
    if (!tag.startsWith(BADGE_TAG_PREFIX)) continue
    const rest = tag.slice(BADGE_TAG_PREFIX.length)
    const hash = rest.lastIndexOf('#')
    const tail = hash === -1 ? '' : rest.slice(hash + 1)
    // The upstream spelling is `badge:<label>:<colour>`, so cutting at the `#`
    // leaves the separator colon stuck to the label (`限时免费:`). Drop it — but
    // ONLY when a colour was actually recognised, because a label may
    // legitimately end in a colon of its own (`活动:下午`) and must survive
    // untouched when no colour follows.
    const isColor = hash !== -1 && COLOR_TAIL.test(tail)
    const cut = (hash === -1 ? rest : rest.slice(0, hash)).trim()
    const label = isColor ? cut.replace(/:$/, '').trim() : cut
    if (label === '') continue
    out.push(isColor ? { label, color: tail } : { label })
  }
  return out
}

/**
 * Whether any badge declares the model free right now.
 *
 * Distinct from the multiplier check in `isFreeModel`: this is the upstream
 * volunteering the fact, which is what lets the card show "限时免费" for a model
 * whose `credits` string never said zero.
 */
export function hasFreeBadge(tags: readonly string[] | undefined): boolean {
  return parseBadgeTags(tags).some(badge => badge.label === BADGE_FREE_LABEL)
}

/** The badge labels alone, in upstream order, without the colour segments. */
export function badgeLabels(tags: readonly string[] | undefined): readonly string[] {
  return parseBadgeTags(tags).map(badge => badge.label)
}

/**
 * Whether a zero price should be spelled out as the generic `免费` label.
 *
 * False in two distinct cases, and the difference matters: a row that is not
 * free-priced at all (the caller is not asking), and a row the gateway ALREADY
 * badged. `hy3` arrives as `multiplier: 0` AND `badge:限时免费`, and emitting both
 * rendered one fact twice ("免费 · 限时免费"). The gateway's own wording is the
 * more informative of the two, so it wins.
 */
export function shouldSpellOutFree(model: { multiplier?: number; tags?: readonly string[] }): boolean {
  if (model.multiplier !== 0) return false
  return badgeLabels(model.tags).length === 0
}

/**
 * Which free presentation wins for one row: the gateway's own badge, or the
 * generic `免费`.
 *
 * The badge branch is gated on the FREE badge, not on "has any badge": the CN
 * roster also writes `badge:夜间折扣` on `glm-5.2`, which is priced at `x0.79`
 * and still costs credits. Reporting a discount row as free would change what
 * the user spends, which is the one thing this plugin must never get wrong.
 * Callers that want to SHOW a non-free badge ask `badgeLabels` separately.
 *
 * Ordered so the free badge wins over the generic label, because `限时免费`
 * ("free, for a limited time") names the part that expires, which the generic
 * label cannot. `undefined` means the row is not free at all and the caller
 * should fall through to its other tag rules.
 *
 * A separately-sorted "is it free right now" question is answered by
 * `isFreeNow` in `promo.ts`, which reads the same badge. Keeping the two apart
 * is why this returns a presentation rather than a boolean.
 */
export function freeBadgeKind(
  model: { multiplier?: number; tags?: readonly string[] },
): 'badge' | 'generic' | undefined {
  if (hasFreeBadge(model.tags)) return 'badge'
  if (model.multiplier === 0 || (model.tags ?? []).includes('free')) return 'generic'
  return undefined
}