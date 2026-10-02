/**
 * Guard the account-usage picker's layout, because a broken grid is invisible
 * to every other test in this suite.
 *
 * The picker grew from three modes to four and the grid stayed at three
 * columns, so the fourth card wrapped onto a line of its own and the row read
 * as a misaligned leftover. Nothing failed: typecheck, tests and the build were
 * all green while the card looked wrong. These assertions are about the
 * properties that actually broke — how many columns the grid declares, whether
 * the selected state is distinguishable, and whether the hint text still has
 * room — since those cannot be caught by a DOM-free test runner.
 *
 * The selection cue is asserted to be the card's OWN (raised surface + neutral
 * inset bar). It is tempting to reach for the host's brand blue here; a test
 * that pins the intent is what stops the next refactor from quietly doing it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const styles = readFileSync(join(ROOT, 'src', 'client', 'styles.ts'), 'utf8')
const card = readFileSync(join(ROOT, 'src', 'client', 'PoolCard.tsx'), 'utf8')
const locales = readFileSync(join(ROOT, 'src', 'client', 'locales.ts'), 'utf8')

/** The body of one CSS rule, or '' when the selector is absent. */
function rule(selector: string): string {
  const start = styles.indexOf(`.${selector}{`)
  if (start < 0) return ''
  const end = styles.indexOf('}', start)
  return end < 0 ? '' : styles.slice(start, end)
}

const MODES = ['sticky', 'priority', 'balanced', 'round-robin'] as const

describe('the mode picker has room for every mode it offers', () => {
  it('offers exactly the four modes the pool implements', () => {
    const declaration = card.slice(card.indexOf('const DIST_OPTIONS'))
    const list = declaration.slice(0, declaration.indexOf(']'))
    for (const mode of MODES) {
      expect(list, `${mode} must be offered`).toContain(`'${mode}'`)
    }
    // A fifth option appearing without the grid being revisited is exactly the
    // regression this file exists for.
    expect(list.match(/'/g)?.length ?? 0).toBe(MODES.length * 2)
  })

  it('does not declare fewer columns than it has modes', () => {
    // The concrete defect: four modes in a three-column grid.
    const options = rule('dsm-workbuddy-xdpool-dist-options')
    expect(options).not.toBe('')
    expect(options, 'a 3-column grid cannot hold 4 modes').not.toContain('repeat(3,')
    expect(options).toMatch(/repeat\(2,/)
  })

  it('collapses to one mode per row when the card is narrow', () => {
    // At 2-up on a narrow panel each card is ~150px wide and the hint wraps to
    // four lines, which is worse than one column.
    const media = styles.slice(styles.indexOf('@media (max-width:760px)'))
    const block = media.slice(0, media.indexOf('/* Automation panel'))
    expect(block).toContain('.dsm-workbuddy-xdpool-dist-options{grid-template-columns:minmax(0,1fr)}')
  })
})

describe('the selected mode is unmistakable', () => {
  it('marks the active card with this card\'s own accent, not a borrowed one', () => {
    // Green means "this account is healthy" two panels down, and the brand blue
    // belongs to the host chrome — a choice control borrowing either one reads
    // as somebody else's status. The card's own language is the raised surface
    // (same as the region tabs) plus a neutral inset bar.
    const active = rule('dsm-workbuddy-xdpool-dist-option-active')
    expect(active).not.toBe('')
    expect(active, 'the accent must be the neutral label colour').toContain('--dsw-alias-label-primary')
    expect(active, 'not the host brand blue').not.toContain('brand-primary')
    expect(active, 'not the health green').not.toContain('state-success')
    expect(active, 'a raised surface is what separates it from hover').toContain('--dsw-alias-bg-layer-3')
    expect(active, 'a wash alone reads as hover').toContain('inset 3px 0 0')
  })

  it('repeats the active mode in the header', () => {
    // The answer to "which one is on?" without scanning four cards.
    expect(rule('dsm-workbuddy-xdpool-dist-now')).not.toBe('')
    expect(card).toContain('dsm-workbuddy-xdpool-dist-now')
  })

  it('gives the recommended mode a badge', () => {
    expect(rule('dsm-workbuddy-xdpool-dist-option-badge')).not.toBe('')
    expect(card).toContain('dsm-workbuddy-xdpool-dist-option-badge')
  })
})

describe('every mode is labelled in both languages', () => {
  const keys = [
    'row.distSticky', 'row.distStickyHint',
    'row.distPriority', 'row.distPriorityHint',
    'row.distBalanced', 'row.distBalancedHint',
    'row.distRoundRobin', 'row.distRoundRobinHint',
    'row.distRecommended',
  ]

  it('defines every label and hint twice (en + zh)', () => {
    for (const key of keys) {
      const hits = locales.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) ?? []
      expect(hits.length, `${key} must exist in both locales`).toBe(2)
    }
  })

  it('labels the modes through helpers, not an inline ternary chain', () => {
    // The four-way nested ternary that used to live in the render body is how
    // the fourth mode got added without the grid being revisited.
    expect(card).toContain('function distLabel(')
    expect(card).toContain('function distHint(')
    expect(card).not.toContain("option === 'sticky'\n                            ? (t?.('row.distSticky')")
  })
})
