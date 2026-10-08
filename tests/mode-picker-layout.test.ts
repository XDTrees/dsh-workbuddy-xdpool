/**
 * Guard the account-usage picker's layout, because a broken grid is invisible
 * to every other test in this suite.
 *
 * The picker grew from three modes to four and the grid stayed at three
 * columns, so the fourth card wrapped onto a line of its own and the row read
 * as a misaligned leftover. Nothing failed: typecheck, tests and the build were
 * all green while the card looked wrong. Then it grew to five and the two-column
 * grid left the fifth card half-width on a row of its own, which read as a card
 * that fell out of the layout — so the row is now a single wrapping flex line:
 * the five chips share it whenever they fit (which they do, down to ~700px) and
 * a wrapped last chip fills its line on its own.
 *
 * These assertions are about the properties that actually broke — whether the
 * row declares a column count that can strand a chip, whether the selected state
 * is distinguishable, and whether the explanation for the chosen mode still has
 * a place — since those cannot be caught by a DOM-free test runner.
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

const MODES = ['sticky', 'priority', 'balanced', 'round-robin', 'expiry'] as const

describe('the mode picker has room for every mode it offers', () => {
  it('offers exactly the modes the pool implements', () => {
    const declaration = card.slice(card.indexOf('const DIST_OPTIONS'))
    const list = declaration.slice(0, declaration.indexOf(']'))
    for (const mode of MODES) {
      expect(list, `${mode} must be offered`).toContain(`'${mode}'`)
    }
    // A further option appearing without the grid being revisited is exactly the
    // regression this file exists for.
    expect(list.match(/'/g)?.length ?? 0).toBe(MODES.length * 2)
  })

  it('lays the modes out as one wrapping row, not a fixed column count', () => {
    // The concrete defect, twice over: four modes in a three-column grid, then
    // five in a two-column one. A declared column count is what stranded a chip,
    // so the property is "the row wraps when it must", not "there are N columns".
    const options = rule('dsm-workbuddy-xdpool-dist-options')
    expect(options).not.toBe('')
    expect(options, 'a 3-column grid cannot hold 4 modes').not.toContain('repeat(3,')
    expect(options, 'a 2-column grid strands the fifth mode').not.toContain('repeat(2,')
    expect(options).toContain('display:flex')
    expect(options).toContain('flex-wrap:wrap')
  })

  it('sizes the chips so five of them share the row on a normal panel', () => {
    // flex-basis is what decides when the row breaks; without a basis the chips
    // shrink to their content and the layout stops being a row of equals.
    const option = rule('dsm-workbuddy-xdpool-dist-option')
    expect(option).toMatch(/flex:1 1 \d+px/)
    expect(option).toContain('min-width:0')
  })

  it('lets a wrapped last chip fill its row without a global span rule', () => {
    // A flex line stretches its items, so the odd chip fills the row on its own.
    // The `:last-child{grid-column:1/-1}` that used to do this had to go: with
    // the modes on ONE line it spans nothing and instead shoves the fifth chip
    // onto a second row while the first row still had room for it.
    const global = styles.slice(0, styles.indexOf('@media (max-width:760px)'))
    expect(global, 'the odd-last span must not apply at full width')
      .not.toContain('.dsm-workbuddy-xdpool-dist-options > :last-child')
  })

  it('does not re-declare a column count when the card is narrow', () => {
    // The narrow breakpoint used to force two columns; with a wrapping row that
    // would be a second, competing layout rule that only fires below 760px.
    const media = styles.slice(styles.indexOf('@media (max-width:760px)'))
    const block = media.slice(0, media.indexOf('/* Automation panel'))
    expect(block).not.toContain('.dsm-workbuddy-xdpool-dist-options{grid-template-columns')
    expect(block, 'a one-chip-tall row must not reserve desktop height').toContain('.dsm-workbuddy-xdpool-dist-option{min-height:0}')
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

  it('explains the chosen mode under the row instead of inside every chip', () => {
    // Five chips each carrying a sentence is five paragraphs of prose in a
    // picker; one line under the row says the same thing about the mode that is
    // actually on, and the chips keep the full text as their tooltip.
    expect(rule('dsm-workbuddy-xdpool-dist-hint')).not.toBe('')
    expect(card).toContain('dsm-workbuddy-xdpool-dist-hint')
    expect(card).toContain('distHint(status.distribution ?? \'priority\', t)')
    // The per-chip hint element is what made each chip two lines tall.
    expect(rule('dsm-workbuddy-xdpool-dist-option-hint')).toBe('')
    expect(card).not.toContain('dsm-workbuddy-xdpool-dist-option-hint')
  })
})

describe('every mode is labelled in both languages', () => {
  const keys = [
    'row.distSticky', 'row.distStickyHint',
    'row.distPriority', 'row.distPriorityHint',
    'row.distBalanced', 'row.distBalancedHint',
    'row.distRoundRobin', 'row.distRoundRobinHint',
    'row.distExpiry', 'row.distExpiryHint',
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
