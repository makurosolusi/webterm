import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILES_PANEL_WIDTH, MAX_TAB_GROUP_NAME, defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import type { Workspace } from '../shared/workspace'
import {
  activateTab, connectTabLayout, createGroup, getTabLayout, groupOf, moveToGroup, reconcileWithNodes, renameGroup, reorderTabs, tabModeOrder,
  setFilesPanelOpen, setFilesPanelWidth, setMode, toggleFilesPanel, toggleGroup, ungroup,
} from './tabLayout.store'

const seeded = (): TabLayout => ({ ...defaultTabLayout(), tabs: { ...defaultTabLayout().tabs, order: ['a', 'b', 'c'], active: 'a' } })

describe('tabLayout.store', () => {
  let write: ReturnType<typeof vi.fn<(next: TabLayout) => void>>
  beforeEach(() => {
    write = vi.fn<(next: TabLayout) => void>()
    connectTabLayout(seeded(), write)
  })

  it('setMode writes only the layout: the workspace nodes/edges stay the very same objects', () => {
    let ws: Workspace = {
      id: 'w', name: 'w', viewport: { x: 1, y: 2, zoom: 1 }, updatedAt: 0, layout: seeded(),
      nodes: [{ id: 'a', kind: 'terminal', x: 10, y: 20 }], bridges: [{ id: 'e', source: 'a', target: 'b', kind: 'context' }],
    }
    const { nodes, bridges, viewport } = ws
    const nodesJson = JSON.stringify(nodes)
    connectTabLayout(ws.layout, (layout) => { ws = { ...ws, layout } })
    setMode('tabs')
    expect(ws.layout?.mode).toBe('tabs')
    expect(ws.nodes).toBe(nodes)
    expect(ws.bridges).toBe(bridges)
    expect(ws.viewport).toBe(viewport)
    expect(JSON.stringify(ws.nodes)).toBe(nodesJson)
    setMode('canvas')
    expect(ws.layout?.mode).toBe('canvas')
    expect(ws.nodes).toBe(nodes)
  })

  it('activateTab only accepts known ids and skips no-op writes', () => {
    activateTab('b')
    expect(getTabLayout().tabs.active).toBe('b')
    activateTab('ghost')
    activateTab('b')
    expect(getTabLayout().tabs.active).toBe('b')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reorderTabs keeps every tab even with a stale or partial order: unlisted ids stay put', () => {
    reorderTabs(['c', 'ghost', 'a'])
    expect(getTabLayout().tabs.order).toEqual(['c', 'b', 'a'])
    reorderTabs(['c', 'b', 'a'])
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('Files nodes are in order and reorderable, but tab mode skips them', () => {
    reconcileWithNodes([{ id: 'a', kind: 'terminal' }, { id: 'b', kind: 'agent' }, { id: 'c', kind: 'editor' }, { id: 'f', kind: 'files' }])
    expect(getTabLayout().tabs.order).toEqual(['a', 'b', 'c', 'f'])
    reorderTabs(['f', 'a', 'b', 'c'])
    expect(getTabLayout().tabs.order).toEqual(['f', 'a', 'b', 'c'])
    expect(write.mock.calls.at(-1)?.[0].tabs.order).toEqual(['f', 'a', 'b', 'c'])
    expect(tabModeOrder()).toEqual(['a', 'b', 'c'])
    activateTab('f')
    expect(getTabLayout().tabs.active).toBe('a')
    // Tab mode reorders without Files: Files keeps its slot.
    reorderTabs(['c', 'a', 'b'])
    expect(getTabLayout().tabs.order).toEqual(['f', 'c', 'a', 'b'])
  })

  it('setFilesPanelWidth clamps; toggleFilesPanel flips open', () => {
    setFilesPanelWidth(1)
    expect(getTabLayout().tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.min)
    setFilesPanelWidth(1e6)
    expect(getTabLayout().tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.max)
    toggleFilesPanel()
    expect(getTabLayout().tabs.filesPanel.open).toBe(false)
    toggleFilesPanel()
    expect(getTabLayout().tabs.filesPanel.open).toBe(true)
  })

  it('setFilesPanelOpen sets the flag explicitly and skips same-value writes', () => {
    setFilesPanelOpen(true)
    expect(write).not.toHaveBeenCalled()
    setFilesPanelOpen(false)
    expect(getTabLayout().tabs.filesPanel.open).toBe(false)
    setFilesPanelOpen(false)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('tabLayout.store groups', () => {
  let write: ReturnType<typeof vi.fn<(next: TabLayout) => void>>
  const order = () => getTabLayout().tabs.order
  const groups = () => getTabLayout().tabs.groups
  beforeEach(() => {
    write = vi.fn<(next: TabLayout) => void>()
    connectTabLayout({ ...defaultTabLayout(), tabs: { ...defaultTabLayout().tabs, order: ['a', 'b', 'c', 'd', 'e'], active: 'a' } }, write)
  })

  it('createGroup names "Group N" (lowest free N), pulls members together and writes', () => {
    const g1 = createGroup(['d', 'b'])
    expect(g1).toMatch(/^g-[0-9a-f-]{36}$/)
    expect(order()).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(groups()).toEqual([{ id: g1, name: 'Group 1', collapsed: false, ids: ['b', 'd'] }])
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe(getTabLayout())
    const g2 = createGroup(['e'])
    expect(groupOf(getTabLayout(), 'e')?.name).toBe('Group 2')
    renameGroup(g1 as string, 'Work')
    expect(groupOf(getTabLayout(), 'a')).toBeUndefined()
    createGroup(['a'])
    expect(groupOf(getTabLayout(), 'a')?.name).toBe('Group 1')
    expect(createGroup(['c'], '  Named  ')).not.toBeNull()
    expect(groupOf(getTabLayout(), 'c')?.name).toBe('Named')
    expect(g2).not.toBe(g1)
  })

  it('createGroup takes nodes out of their old group and returns null for nothing to group', () => {
    const g1 = createGroup(['a', 'b']) as string
    const g2 = createGroup(['b', 'c']) as string
    expect(groupOf(getTabLayout(), 'b')?.id).toBe(g2)
    expect(groups().find((g) => g.id === g1)?.ids).toEqual(['a'])
    write.mockClear()
    expect(createGroup([])).toBeNull()
    expect(createGroup(['ghost'])).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('ungroup removes the group and leaves nodes in place', () => {
    const g = createGroup(['b', 'c']) as string
    const before = order()
    ungroup(g)
    expect(groups()).toEqual([])
    expect(order()).toEqual(before)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('renameGroup trims and cuts; a blank name is a no-op', () => {
    const g = createGroup(['a']) as string
    renameGroup(g, '   ')
    expect(groups()[0].name).toBe('Group 1')
    expect(write).toHaveBeenCalledTimes(1)
    renameGroup(g, `  ${'n'.repeat(MAX_TAB_GROUP_NAME + 5)} `)
    expect(groups()[0].name).toBe('n'.repeat(MAX_TAB_GROUP_NAME))
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('toggleGroup flips or sets collapsed, skipping no-op writes', () => {
    const g = createGroup(['a']) as string
    toggleGroup(g)
    expect(groups()[0].collapsed).toBe(true)
    toggleGroup(g, true)
    expect(write).toHaveBeenCalledTimes(2)
    toggleGroup(g, false)
    expect(groups()[0].collapsed).toBe(false)
    expect(write).toHaveBeenCalledTimes(3)
  })

  it('moveToGroup moves into a group (end), before a member, and out to the top level', () => {
    const g = createGroup(['b', 'c']) as string // order a [b c] d e
    moveToGroup('e', g)
    expect(order()).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(groups()[0].ids).toEqual(['b', 'c', 'e'])
    moveToGroup('a', g, 'c')
    expect(order()).toEqual(['b', 'a', 'c', 'e', 'd'])
    expect(groupOf(getTabLayout(), 'a')?.id).toBe(g)
    moveToGroup('c', null)
    expect(order()).toEqual(['b', 'a', 'e', 'd', 'c'])
    expect(groups()[0].ids).toEqual(['b', 'a', 'e'])
    moveToGroup('d', null, 'a') // top level before a grouped node = before that group
    expect(order()).toEqual(['d', 'b', 'a', 'e', 'c'])
    moveToGroup('c', null, 'd')
    expect(order()).toEqual(['c', 'd', 'b', 'a', 'e'])
    expect(write).toHaveBeenCalledTimes(6)
    moveToGroup('ghost', g)
    moveToGroup('a', 'no-such-group')
    expect(write).toHaveBeenCalledTimes(6)
  })

  it('moveToGroup into an empty group keeps the node in its slot', () => {
    const g1 = createGroup(['c']) as string
    ungroup(g1)
    const g = createGroup(['a']) as string
    moveToGroup('a', null)
    expect(groups()[0].ids).toEqual([])
    moveToGroup('c', g)
    expect(order()).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(groupOf(getTabLayout(), 'c')?.id).toBe(g)
  })

  it('reorderTabs that splits a group pulls its members back together', () => {
    createGroup(['b', 'c']) // a [b c] d e
    reorderTabs(['a', 'b', 'd', 'c', 'e'])
    expect(order()).toEqual(['a', 'b', 'c', 'd', 'e'])
    reorderTabs(['b', 'c', 'a', 'd', 'e']) // moving the whole group is fine
    expect(order()).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('reconcile drops a deleted member but keeps its group', () => {
    const g = createGroup(['b']) as string
    reconcileWithNodes(['a', 'c', 'd', 'e'].map((id) => ({ id, kind: 'terminal' as const })))
    expect(groups()).toEqual([{ id: g, name: 'Group 1', collapsed: false, ids: [] }])
    expect(write.mock.calls.at(-1)?.[0].tabs.groups[0].ids).toEqual([])
  })
})
