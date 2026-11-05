import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILES_PANEL_WIDTH, defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import type { Workspace } from '../shared/workspace'
import {
  activateTab, connectTabLayout, getTabLayout, reorderTabs, setFilesPanelWidth, setMode, toggleFilesPanel,
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

  it('reorderTabs keeps every tab even with a stale or partial order', () => {
    reorderTabs(['c', 'ghost', 'a'])
    expect(getTabLayout().tabs.order).toEqual(['c', 'a', 'b'])
    reorderTabs(['c', 'a', 'b'])
    expect(write).toHaveBeenCalledTimes(1)
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
})
