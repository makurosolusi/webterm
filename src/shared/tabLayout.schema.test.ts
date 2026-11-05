import { describe, expect, it } from 'vitest'
import {
  FILES_PANEL_WIDTH, TAB_LAYOUT_LIMITS, defaultTabLayout, isTabKind, normalizeTabLayout, reconcileTabs, type TabLayout,
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

  it('never puts a Files node in order (it is the panel)', () => {
    expect(isTabKind('files')).toBe(false)
    const r = reconcileTabs(layout(['f', 'a'], 'f'), [node('f', 'files'), node('a', 'agent'), node('e', 'editor'), node('b', 'browser')])
    expect(r.tabs.order).toEqual(['a', 'e', 'b'])
    expect(r.tabs.active).toBe('a')
  })

  it('returns the same object when nothing changed, and keeps mode and panel', () => {
    const l = { ...layout(['a'], 'a'), mode: 'tabs' as const }
    expect(reconcileTabs(l, [node('a')])).toBe(l)
    const r = reconcileTabs(l, [node('a'), node('b')])
    expect(r.mode).toBe('tabs')
    expect(r.tabs.filesPanel).toBe(l.tabs.filesPanel)
  })
})
