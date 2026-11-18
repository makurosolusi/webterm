import { describe, expect, it } from 'vitest'
import {
  MAX_PANES, assignTab, canSplit, closePane, focusPane, layoutAfterClose, layoutTabIds, normalizeLayout, paneCount,
  resizePane, splitPane, swapPanes, validLayout,
} from './browser.layout'
import type { Pane } from './workspace.shape'

const L = (id: string): Pane => ({ id })
const two = splitPane(null, 'a', 'b', 'right')

describe('splitPane', () => {
  it('turns "no layout" into two panes, new one on the chosen edge', () => {
    expect(two).toEqual({ dir: 'h', ratio: 0.5, a: L('a'), b: L('b') })
    expect(splitPane(null, 'a', 'b', 'left')).toEqual({ dir: 'h', ratio: 0.5, a: L('b'), b: L('a') })
    expect(splitPane(null, 'a', 'b', 'bottom')).toMatchObject({ dir: 'v', a: L('a'), b: L('b') })
    expect(splitPane(null, 'a', 'b', 'top')).toMatchObject({ dir: 'v', a: L('b'), b: L('a') })
  })
  it('splits the target pane inside an existing tree', () => {
    const three = splitPane(two, 'b', 'c', 'bottom')
    expect(layoutTabIds(three)).toEqual(['a', 'b', 'c'])
    expect((three as { b: Pane }).b).toMatchObject({ dir: 'v', a: L('b'), b: L('c') })
  })
  it('refuses a tab that is already shown, an unknown target, and the 5th pane', () => {
    expect(splitPane(two, 'a', 'b', 'right')).toBe(two)
    expect(splitPane(two, 'zz', 'c', 'right')).toBe(two)
    let t: Pane = two
    t = splitPane(t, 'a', 'c', 'bottom')
    t = splitPane(t, 'b', 'd', 'bottom')
    expect(paneCount(t)).toBe(MAX_PANES)
    expect(canSplit(t)).toEqual({ ok: false, reason: 'Pane limit (4) reached' })
    expect(splitPane(t, 'a', 'e', 'right')).toBe(t)
  })
})

describe('closePane', () => {
  it('collapses to the sibling, never removes the last pane', () => {
    expect(closePane(two, 'a')).toEqual(L('b'))
    expect(closePane(L('a'), 'a')).toEqual(L('a'))
    expect(closePane(two, 'nope')).toBe(two)
  })
  it('keeps the rest of a bigger tree', () => {
    const three = splitPane(two, 'b', 'c', 'bottom')
    expect(layoutTabIds(closePane(three, 'b'))).toEqual(['a', 'c'])
  })
})

describe('assignTab / swapPanes', () => {
  it('shows another tab in a pane', () => {
    expect(layoutTabIds(assignTab(two, 'b', 'x'))).toEqual(['a', 'x'])
  })
  it('swaps when the tab is already in another pane (a tab shows once)', () => {
    expect(layoutTabIds(assignTab(two, 'a', 'b'))).toEqual(['b', 'a'])
    expect(layoutTabIds(swapPanes(two, 'a', 'b'))).toEqual(['b', 'a'])
  })
  it('ignores unknown panes', () => {
    expect(assignTab(two, 'zz', 'x')).toBe(two)
    expect(swapPanes(two, 'a', 'zz')).toBe(two)
  })
})

describe('resizePane', () => {
  it('clamps the ratio and addresses nested splits by path', () => {
    expect((resizePane(two, '', 0.7) as { ratio: number }).ratio).toBe(0.7)
    expect((resizePane(two, '', 0) as { ratio: number }).ratio).toBe(0.1)
    expect((resizePane(two, '', 5) as { ratio: number }).ratio).toBe(0.9)
    const three = splitPane(two, 'b', 'c', 'bottom')
    expect(((resizePane(three, 'b', 0.3) as { b: { ratio: number } }).b).ratio).toBe(0.3)
    expect(resizePane(three, 'x', 0.3)).toBe(three)
    expect(resizePane(L('a'), '', 0.3)).toEqual(L('a'))
  })
  it('keeps identity when nothing changes', () => {
    expect(resizePane(two, '', 0.5)).toBe(two)
  })
})

describe('focusPane', () => {
  const grid = splitPane(splitPane(two, 'a', 'c', 'bottom'), 'b', 'd', 'bottom') // a|b over c|d
  it('moves to the neighbour in the direction, stays at the edge', () => {
    expect(focusPane(grid, 'a', 'right')).toBe('b')
    expect(focusPane(grid, 'a', 'down')).toBe('c')
    expect(focusPane(grid, 'd', 'left')).toBe('c')
    expect(focusPane(grid, 'd', 'up')).toBe('b')
    expect(focusPane(grid, 'a', 'left')).toBe('a')
    expect(focusPane(grid, 'a', 'up')).toBe('a')
  })
})

describe('layoutAfterClose', () => {
  it('shows the nearest hidden tab (right, then left) in the closed pane', () => {
    expect(layoutAfterClose(two, 'b', ['a', 'b', 'c'])).toEqual({ layout: two && { dir: 'h', ratio: 0.5, a: L('a'), b: L('c') }, focus: 'c' })
    expect(layoutAfterClose(two, 'b', ['x', 'a', 'b']).focus).toBe('x')
  })
  it('collapses the pane when every tab is on screen, and drops the split at one pane', () => {
    expect(layoutAfterClose(two, 'b', ['a', 'b'])).toEqual({ layout: null, focus: 'a' })
    const three = splitPane(two, 'b', 'c', 'bottom')
    const r = layoutAfterClose(three, 'b', ['a', 'b', 'c'])
    expect(layoutTabIds(r.layout as Pane)).toEqual(['a', 'c'])
  })
  it('leaves a layout alone when the closed tab is not on screen', () => {
    expect(layoutAfterClose(two, 'z', ['a', 'b', 'z']).layout).toBe(two)
  })
})

describe('validLayout', () => {
  it('accepts a good tree and normalises to undefined below two panes', () => {
    expect(validLayout(two)).toEqual(two)
    expect(validLayout({ id: 'a' })).toBeUndefined()
    expect(validLayout(null)).toBeUndefined()
    expect(normalizeLayout(L('a'))).toBeNull()
  })
  it('clamps ratio, cuts duplicates and over-limit panes, collapses junk sides', () => {
    expect((validLayout({ dir: 'h', ratio: 9, a: L('a'), b: L('b') }) as { ratio: number }).ratio).toBe(0.9)
    expect(validLayout({ dir: 'h', ratio: 0.5, a: L('a'), b: L('a') })).toBeUndefined()
    expect(validLayout({ dir: 'x', ratio: 0.5, a: L('a'), b: L('b') })).toBeUndefined()
    const five = { dir: 'h', ratio: 0.5, a: { dir: 'h', ratio: 0.5, a: L('a'), b: L('b') }, b: { dir: 'h', ratio: 0.5, a: L('c'), b: { dir: 'h', ratio: 0.5, a: L('d'), b: L('e') } } }
    expect(layoutTabIds(validLayout(five) as Pane)).toEqual(['a', 'b', 'c', 'd'])
    expect(validLayout({ dir: 'h', ratio: 0.5, a: L('a'), b: L('bad id!') })).toBeUndefined()
  })
  it('collapses tabs that no longer exist', () => {
    const three = splitPane(two, 'b', 'c', 'bottom')
    expect(layoutTabIds(validLayout(three, ['a', 'c']) as Pane)).toEqual(['a', 'c'])
    expect(validLayout(three, ['a'])).toBeUndefined()
  })
})
