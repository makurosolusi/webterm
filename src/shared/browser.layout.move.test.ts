import { describe, expect, it } from 'vitest'
import { MAX_PANES, layoutTabIds, movePane, paneCount, splitPane, validLayout } from './browser.layout'
import type { Pane } from './workspace.shape'

const L = (id: string): Pane => ({ id })
const cols = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ dir: 'h', ratio, a, b })
const rows = (a: Pane, b: Pane, ratio = 0.5): Pane => ({ dir: 'v', ratio, a, b })
const two = cols(L('a'), L('b'), 0.3)
const three = cols(L('a'), rows(L('b'), L('c')))
const grid = rows(cols(L('a'), L('b')), cols(L('c'), L('d')))

describe('movePane: center swaps', () => {
  it('exchanges the two tabs and keeps the geometry', () => {
    expect(movePane(two, 'a', 'b', 'center')).toEqual(cols(L('b'), L('a'), 0.3))
    expect(movePane(grid, 'a', 'd', 'center')).toEqual(rows(cols(L('d'), L('b')), cols(L('c'), L('a'))))
  })
  it('is its own inverse', () => {
    expect(movePane(movePane(grid, 'b', 'c', 'center'), 'b', 'c', 'center')).toEqual(grid)
  })
})

describe('movePane: an edge relocates', () => {
  it('lifts the pane out (its split collapses) and splits the target 50/50 on that side', () => {
    expect(movePane(three, 'c', 'a', 'left')).toEqual(cols(cols(L('c'), L('a')), L('b')))
    expect(movePane(three, 'a', 'c', 'bottom')).toEqual(rows(L('b'), rows(L('c'), L('a'))))
    expect(movePane(three, 'a', 'b', 'top')).toEqual(rows(rows(L('a'), L('b')), L('c')))
    expect(movePane(three, 'a', 'c', 'right')).toEqual(rows(L('b'), cols(L('c'), L('a'))))
  })
  it('uses an even ratio for the new split, whatever the old one was', () => {
    const r = movePane(cols(L('a'), cols(L('b'), L('c'), 0.2), 0.7), 'a', 'c', 'right') as { b: { ratio: number } }
    expect(r.b.ratio).toBe(0.5)
  })
  it('moving beside the sibling it already shares a split with just changes the side', () => {
    expect(movePane(two, 'a', 'b', 'right')).toEqual(cols(L('b'), L('a')))
    expect(movePane(two, 'a', 'b', 'bottom')).toEqual(rows(L('b'), L('a')))
  })
  it('collapses an emptied split and never loses or duplicates a tab', () => {
    const moved = movePane(grid, 'a', 'd', 'right')
    expect(layoutTabIds(moved).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(paneCount(moved)).toBe(4)
  })
  it('never counts against the pane limit: the pane leaves before it lands', () => {
    expect(paneCount(grid)).toBe(MAX_PANES)
    expect(paneCount(movePane(grid, 'a', 'd', 'top'))).toBe(MAX_PANES)
    expect(movePane(grid, 'a', 'd', 'top')).not.toBe(grid)
  })
  it('stays a layout the server would accept', () => {
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      const moved = movePane(grid, 'b', 'c', edge)
      expect(validLayout(moved, ['a', 'b', 'c', 'd'])).toEqual(moved)
    }
  })
  it('is idempotent: dropping again on the same edge changes nothing more', () => {
    const once = movePane(three, 'a', 'c', 'bottom')
    expect(movePane(once, 'a', 'c', 'bottom')).toEqual(once)
  })
})

describe('movePane: refusals return the same value', () => {
  it('unknown ids, itself, and a single pane', () => {
    expect(movePane(two, 'zz', 'a', 'left')).toBe(two)
    expect(movePane(two, 'a', 'zz', 'center')).toBe(two)
    expect(movePane(two, 'a', 'a', 'center')).toBe(two)
    expect(movePane(two, 'a', 'a', 'left')).toBe(two)
    expect(movePane(L('a'), 'a', 'b', 'left')).toEqual(L('a'))
  })
  it('does not mutate its input', () => {
    const before = JSON.stringify(grid)
    movePane(grid, 'a', 'd', 'left')
    expect(JSON.stringify(grid)).toBe(before)
  })
  it('agrees with splitPane for the tab that is not on screen yet (the two gestures share the zones)', () => {
    expect(splitPane(two, 'a', 'c', 'left')).toEqual(cols(cols(L('c'), L('a')), L('b'), 0.3))
  })
})
