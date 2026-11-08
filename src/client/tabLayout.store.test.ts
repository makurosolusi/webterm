import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILES_PANEL_WIDTH, defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import type { Workspace } from '../shared/workspace'
import {
  activateTab, connectTabLayout, getTabLayout, reconcileWithNodes, reorderTabs, tabModeOrder, setFilesPanelOpen, setFilesPanelWidth, setMode, toggleFilesPanel,
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
