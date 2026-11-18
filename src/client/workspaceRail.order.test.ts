// Pure logic behind the rail tiles: display order, moves, pending order, keys, overflow, drag slot.
import { describe, expect, it } from 'vitest'
import { applyPendingOrder, moveId, orderedWorkspaces, sameOrder } from './workspaceRail.order'
import { focusIndex, tileKeyIntent } from './workspaceRail.keys'
import { tilesOverflow } from './workspaceRail.overflow'
import { slotAtY } from './workspaceRail.drag'
import { neighborWorkspaceId } from './workspaceNav.commands'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const w = (id: string, position?: number): Workspace =>
  ({ id, name: id, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, ...(position === undefined ? {} : { position }) }) as Workspace // test-only
const ids = (list: Workspace[]): string[] => list.map((x) => x.id)

describe('orderedWorkspaces', () => {
  it('sorts by position ascending when every workspace has one', () => {
    expect(ids(orderedWorkspaces([w('c', 2), w('a', 0), w('b', 1)]))).toEqual(['a', 'b', 'c'])
  })
  it('keeps the received order when any position is missing (before the order API exists)', () => {
    expect(ids(orderedWorkspaces([w('c'), w('a', 0), w('b', 1)]))).toEqual(['c', 'a', 'b'])
    expect(ids(orderedWorkspaces([w('b'), w('a')]))).toEqual(['b', 'a'])
  })
  it('is stable for equal positions and does not mutate the input', () => {
    const input = [w('x', 1), w('y', 1), w('z', 0)]
    expect(ids(orderedWorkspaces(input))).toEqual(['z', 'x', 'y'])
    expect(ids(input)).toEqual(['x', 'y', 'z'])
  })
})

describe('moveId / sameOrder / applyPendingOrder', () => {
  it('moves an id to an index and clamps', () => {
    expect(moveId(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveId(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
  })
  it('returns the same array when nothing moves or the id is unknown', () => {
    const list = ['a', 'b']
    expect(moveId(list, 'a', 0)).toBe(list)
    expect(moveId(list, 'zz', 1)).toBe(list)
  })
  it('compares order exactly', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
  it('applies a pending order only while it describes the same workspaces', () => {
    const list = [w('a'), w('b'), w('c')]
    expect(ids(applyPendingOrder(list, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
    expect(applyPendingOrder(list, ['c', 'a'])).toBe(list)
    expect(applyPendingOrder(list, ['c', 'a', 'zz'])).toBe(list)
    expect(applyPendingOrder(list, null)).toBe(list)
  })
})

describe('tileKeyIntent', () => {
  const k = (key: string, mods: Partial<Record<'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) =>
    tileKeyIntent({ key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods })
  it('maps the vertical tablist keys', () => {
    expect(k('ArrowDown')).toEqual({ kind: 'focus', to: 'next' })
    expect(k('ArrowUp')).toEqual({ kind: 'focus', to: 'prev' })
    expect(k('Home')).toEqual({ kind: 'focus', to: 'first' })
    expect(k('End')).toEqual({ kind: 'focus', to: 'last' })
    expect(k('Enter')).toEqual({ kind: 'activate' })
    expect(k(' ')).toEqual({ kind: 'activate' })
    expect(k('F2')).toEqual({ kind: 'rename' })
    expect(k('ContextMenu')).toEqual({ kind: 'menu' })
    expect(k('F10', { shiftKey: true })).toEqual({ kind: 'menu' })
  })
  it('Alt+Shift+Up/Down reorder; horizontal arrows and other chords are not tile keys', () => {
    expect(k('ArrowUp', { altKey: true, shiftKey: true })).toEqual({ kind: 'move', dir: -1 })
    expect(k('ArrowDown', { altKey: true, shiftKey: true })).toEqual({ kind: 'move', dir: 1 })
    expect(k('ArrowRight')).toBeNull()
    expect(k('ArrowDown', { metaKey: true })).toBeNull()
    expect(k('ArrowDown', { shiftKey: true })).toBeNull()
  })
  it('focusIndex wraps at both ends', () => {
    expect(focusIndex('next', 2, 3)).toBe(0)
    expect(focusIndex('prev', 0, 3)).toBe(2)
    expect(focusIndex('first', 2, 3)).toBe(0)
    expect(focusIndex('last', 0, 3)).toBe(2)
  })
})

describe('overflow and drag geometry', () => {
  it('tilesOverflow ignores a sub-pixel difference and flags a real one', () => {
    expect(tilesOverflow(100, 100)).toBe(false)
    expect(tilesOverflow(100.5, 100)).toBe(false)
    expect(tilesOverflow(140, 100)).toBe(true)
  })
  it('slotAtY counts tiles whose midpoint is above the pointer', () => {
    const rects = [{ top: 0, bottom: 36 }, { top: 36, bottom: 72 }, { top: 72, bottom: 108 }]
    expect(slotAtY(rects, 5)).toBe(0)
    expect(slotAtY(rects, 40)).toBe(1)
    expect(slotAtY(rects, 200)).toBe(3)
  })
})

describe('neighborWorkspaceId (Workspace: Next / Previous)', () => {
  it('wraps and does nothing with fewer than two workspaces', () => {
    expect(neighborWorkspaceId(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(neighborWorkspaceId(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(neighborWorkspaceId(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(neighborWorkspaceId(['a'], 'a', 1)).toBeNull()
    expect(neighborWorkspaceId(['a', 'b'], null, 1)).toBe('a')
  })
})
