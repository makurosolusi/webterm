import { describe, expect, it } from 'vitest'
import {
  FILES_PANEL_WIDTH, MAX_TAB_GROUPS, MAX_TAB_GROUP_NAME, TAB_LAYOUT_LIMITS, defaultTabLayout, isTabKind, normalizeTabLayout, reconcileTabs,
  type TabGroup, type TabLayout,
} from './tabLayout.schema'
import type { WsNodeKind } from './workspace.shape'

const layout = (order: string[], active: string | null): TabLayout => {
  const l = defaultTabLayout()
  return { ...l, tabs: { ...l.tabs, order, active } }
}
const node = (id: string, kind: WsNodeKind = 'terminal') => ({ id, kind })

describe('normalizeTabLayout', () => {
  it('defaults to canvas mode with an open Files panel at the default width', () => {
    expect(normalizeTabLayout(undefined)).toEqual(defaultTabLayout())
    expect(defaultTabLayout().tabs.filesPanel).toEqual({ open: true, width: FILES_PANEL_WIDTH.default })
    expect(normalizeTabLayout('nope')).toEqual(defaultTabLayout())
  })

  it('repairs dirty input field by field', () => {
    const l = normalizeTabLayout({
      mode: 'grid',
      tabs: { order: ['a', 'a', 7, '', null, 'b', 'x'.repeat(TAB_LAYOUT_LIMITS.idLength + 1)], active: 'ghost', filesPanel: { open: 'yes', width: 99999 } },
    })
    expect(l.mode).toBe('canvas')
    expect(l.tabs.order).toEqual(['a', 'b'])
    expect(l.tabs.active).toBeNull()
    expect(l.tabs.filesPanel).toEqual({ open: true, width: FILES_PANEL_WIDTH.max })
  })

  it('clamps low and non-finite widths, keeps a valid state', () => {
    expect(normalizeTabLayout({ tabs: { filesPanel: { width: 1 } } }).tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.min)
    expect(normalizeTabLayout({ tabs: { filesPanel: { width: NaN } } }).tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.default)
    const ok = layout(['a', 'b'], 'b')
    expect(normalizeTabLayout({ ...ok, mode: 'tabs' })).toEqual({ ...ok, mode: 'tabs' })
  })

  it('caps the number of tabs', () => {
    const many = Array.from({ length: TAB_LAYOUT_LIMITS.tabs + 50 }, (_, i) => `n${i}`)
    expect(normalizeTabLayout({ tabs: { order: many } }).tabs.order).toHaveLength(TAB_LAYOUT_LIMITS.tabs)
  })
})

describe('reconcileTabs', () => {
  it('drops removed nodes and appends new ones at the end', () => {
    const r = reconcileTabs(layout(['a', 'b', 'c'], 'a'), [node('c'), node('a'), node('d')])
    expect(r.tabs.order).toEqual(['a', 'c', 'd'])
    expect(r.tabs.active).toBe('a')
  })

  it('moves a vanished active to the nearest survivor (right first, then left)', () => {
    expect(reconcileTabs(layout(['a', 'b', 'c'], 'b'), [node('a'), node('c')]).tabs.active).toBe('c')
    expect(reconcileTabs(layout(['a', 'b', 'c'], 'c'), [node('a'), node('b')]).tabs.active).toBe('b')
  })

  it('falls back to the last tab for an unset active, and to null with no tabs', () => {
    expect(reconcileTabs(layout([], null), [node('a'), node('b')]).tabs.active).toBe('b')
    expect(reconcileTabs(layout(['a'], 'a'), []).tabs.active).toBeNull()
  })

  it('keeps Files nodes in order (canvas strip) but never makes one the tab-mode active tab', () => {
    expect(isTabKind('files')).toBe(false)
    const r = reconcileTabs(layout(['f', 'a'], 'f'), [node('f', 'files'), node('a', 'agent'), node('e', 'editor'), node('b', 'browser')])
    expect(r.tabs.order).toEqual(['f', 'a', 'e', 'b'])
    expect(r.tabs.active).toBe('a')
    expect(reconcileTabs(layout([], null), [node('a'), node('f', 'files')]).tabs.active).toBe('a')
  })

  it('returns the same object when nothing changed, and keeps mode and panel', () => {
    const l = { ...layout(['a'], 'a'), mode: 'tabs' as const }
    expect(reconcileTabs(l, [node('a')])).toBe(l)
    const r = reconcileTabs(l, [node('a'), node('b')])
    expect(r.mode).toBe('tabs')
    expect(r.tabs.filesPanel).toBe(l.tabs.filesPanel)
  })
})

const grp = (id: string, ids: string[], name = id): TabGroup => ({ id, name, collapsed: false, ids })
const grouped = (order: string[], groups: TabGroup[]): TabLayout => {
  const l = layout(order, null)
  return { ...l, tabs: { ...l.tabs, groups } }
}

describe('normalizeTabLayout groups', () => {
  it('an old layout without groups loads with an empty list', () => {
    const l = normalizeTabLayout({ mode: 'tabs', tabs: { order: ['a'], active: 'a', filesPanel: { open: true, width: 300 } } })
    expect(l.tabs.groups).toEqual([])
    expect(l.tabs.order).toEqual(['a'])
    expect(normalizeTabLayout({ tabs: { order: ['a'], groups: 'nope' } }).tabs.groups).toEqual([])
  })

  it('drops malformed groups and coerces the rest', () => {
    const l = normalizeTabLayout({
      tabs: {
        order: ['a', 'b', 'c'],
        groups: [
          null, 7, 'g', { name: 'no id' }, { id: '' }, { id: 'bad id!' }, { id: 'x'.repeat(65) },
          { id: 'g1', name: '  Work  ', collapsed: 'yes', ids: ['a', 3, 'ghost', 'a'] },
          { id: 'g1', name: 'dup id', ids: ['b'] },
          { id: 'g2', name: '   ', collapsed: true, ids: 'b' },
          { id: 'g3', name: 'z'.repeat(MAX_TAB_GROUP_NAME + 20), ids: ['c'] },
        ],
      },
    })
    expect(l.tabs.groups).toEqual([
      { id: 'g1', name: 'Work', collapsed: false, ids: ['a'] },
      { id: 'g2', name: 'Group', collapsed: true, ids: [] },
      { id: 'g3', name: 'z'.repeat(MAX_TAB_GROUP_NAME), collapsed: false, ids: ['c'] },
    ])
  })

  it('a node id belongs to the first group that lists it', () => {
    const l = normalizeTabLayout({ tabs: { order: ['a', 'b'], groups: [grp('g1', ['a']), grp('g2', ['a', 'b'])] } })
    expect(l.tabs.groups.map((g) => g.ids)).toEqual([['a'], ['b']])
  })

  it('caps the group count', () => {
    const many = Array.from({ length: MAX_TAB_GROUPS + 10 }, (_, i) => grp(`g${i}`, []))
    expect(normalizeTabLayout({ tabs: { groups: many } }).tabs.groups).toHaveLength(MAX_TAB_GROUPS)
  })

  it('restores contiguity at the first member and sorts ids by order', () => {
    const l = normalizeTabLayout({ tabs: { order: ['x', 'b', 'y', 'a', 'z', 'c'], groups: [grp('g', ['c', 'a', 'b'])] } })
    expect(l.tabs.order).toEqual(['x', 'b', 'a', 'c', 'y', 'z'])
    expect(l.tabs.groups[0].ids).toEqual(['b', 'a', 'c'])
  })

  it('a valid grouped layout normalizes to itself', () => {
    const ok = grouped(['a', 'b', 'c'], [{ id: 'g-1', name: 'Work', collapsed: true, ids: ['b', 'c'] }])
    expect(normalizeTabLayout(ok)).toEqual(ok)
  })
})

describe('reconcileTabs groups', () => {
  it('prunes dead ids from groups but keeps the emptied group', () => {
    const r = reconcileTabs(grouped(['a', 'b', 'c'], [grp('g1', ['a', 'b']), grp('g2', ['c'])]), [node('b'), node('d')])
    expect(r.tabs.order).toEqual(['b', 'd'])
    expect(r.tabs.groups).toEqual([grp('g1', ['b']), grp('g2', [])])
  })

  it('repairs a split group and stays identical when already consistent', () => {
    const r = reconcileTabs(grouped(['a', 'x', 'b'], [grp('g', ['a', 'b'])]), [node('a'), node('x'), node('b')])
    expect(r.tabs.order).toEqual(['a', 'b', 'x'])
    expect(reconcileTabs(r, [node('a'), node('x'), node('b')])).toBe(r)
  })
})
