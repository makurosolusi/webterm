// Pure logic behind the workspace tab order: display order, moves, pending order, drag slot and indicator.
import { describe, expect, it } from 'vitest'
import { applyPendingOrder, applyServerOrder, moveId, orderedWorkspaces, sameOrder } from './workspaceOrder.list'
import { dropSide } from './workspaceTabs.drag'
import { slotAt } from './browserTabs/browserTabs.drag'
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

describe('tab drag geometry', () => {
  it('slotAt counts tabs whose midpoint is left of the pointer (the browser strip\'s own rule)', () => {
    const rects = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }]
    expect(slotAt(rects, 10)).toBe(0)
    expect(slotAt(rects, 120)).toBe(1)
    expect(slotAt(rects, 900)).toBe(3)
  })
  it('dropSide draws the insertion line before the target tab, or after the last one, and nothing without a slot', () => {
    expect(dropSide({ id: 'a', slot: null }, 0, 3)).toBeUndefined()
    expect(dropSide(null, 0, 3)).toBeUndefined()
    expect(dropSide({ id: 'a', slot: 1 }, 1, 3)).toBe('before')
    expect(dropSide({ id: 'a', slot: 1 }, 0, 3)).toBeUndefined()
    expect(dropSide({ id: 'a', slot: 3 }, 2, 3)).toBe('after')
    expect(dropSide({ id: 'a', slot: 3 }, 1, 3)).toBeUndefined()
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

describe('applyServerOrder', () => {
  const w = (id: string, position?: number): Workspace => ({ id, name: id, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 1, ...(position === undefined ? {} : { position }) }) // test-only
  it('sorts by ids, rewrites position, appends unlisted ids in their order', () => {
    const out = applyServerOrder([w('a', 0), w('b', 1), w('c', 2)], ['c', 'a'])
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(orderedWorkspaces(out).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })
  it('leaves entries without a position without one', () => {
    expect(applyServerOrder([w('a'), w('b')], ['b', 'a'])).toEqual([w('b'), w('a')])
  })
})
