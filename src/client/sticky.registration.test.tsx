/** @vitest-environment jsdom */
// A sticky note reaches every registry end to end: the store round trip (a field missing from either direction is
// dropped silently on save), tab mode (it is not a tab), the command palette, the canvas menu, the mini-map and the font import.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import { STICKY_COLORS, STICKY_DEFAULT_SIZE, STICKY_TAG_MAX, STICKY_TEXT_MAX, stickyHex } from '../shared/sticky.palette'
import { defaultTabLayout, isTabKind, reconcileTabs } from '../shared/tabLayout.schema'
import type { WsNode } from '../shared/workspace'
import { toFlow, toWsNode } from './store'
import { KIND_ICON, NODE_KIND_LABEL, nodeRowLabel } from './nodeList'
import { miniMapNodeColor } from './canvasStyle'
import { appCommands, type AppCommandDeps } from './commandRegistry.defaults'
import { buildCanvasMenuRows } from './canvasMenu.model'
import { reconcileWithNodes, tabModeOrder } from './tabLayout.store'
import { getLastStickyColor, setLastStickyColor } from './sticky.state'
import { STICKY_NEW_KEY } from './sticky.labels'

const sticky: WsNode = { id: 's1', kind: 'sticky', x: 10, y: 20, width: 200, height: 220, stickyText: 'Fix login\nsecond line', stickyTag: 'P2', stickyColor: 'violet' }

describe('store round trip', () => {
  it('keeps text, tag and color in both directions', () => {
    const back = toWsNode(toFlow(sticky))
    expect(back).toMatchObject({ kind: 'sticky', stickyText: 'Fix login\nsecond line', stickyTag: 'P2', stickyColor: 'violet', width: 200, height: 220 })
  })

  it('defaults the size from the palette constant and drops junk on the way out', () => {
    const bare = toFlow({ id: 's2', kind: 'sticky', x: 0, y: 0 })
    expect(bare).toMatchObject({ width: STICKY_DEFAULT_SIZE.width, height: STICKY_DEFAULT_SIZE.height })
    const dirty = toWsNode({ id: 's3', type: 'sticky', position: { x: 0, y: 0 }, data: { stickyText: 'x'.repeat(STICKY_TEXT_MAX + 50), stickyTag: ` ${'t'.repeat(60)} `, stickyColor: 'chartreuse' } } as Node)
    expect(dirty.stickyText).toHaveLength(STICKY_TEXT_MAX)
    expect(dirty.stickyTag).toHaveLength(STICKY_TAG_MAX)
    expect(dirty.stickyColor).toBeUndefined()
  })
})

describe('sticky is not a tab', () => {
  it('is excluded from tab kinds and from the tab-mode order, and is never the active tab', () => {
    expect(isTabKind('sticky')).toBe(false)
    expect(isTabKind('terminal')).toBe(true)
    const nodes = [{ id: 's1', kind: 'sticky' as const }, { id: 't1', kind: 'terminal' as const }]
    reconcileWithNodes(nodes)
    expect(tabModeOrder()).toEqual(['t1'])
    const layout = reconcileTabs({ ...defaultTabLayout(), tabs: { ...defaultTabLayout().tabs, active: 's1' } }, nodes)
    expect(layout.tabs.active).toBe('t1')
  })
})

describe('registries', () => {
  it('has a label, an icon and a row label', () => {
    expect(NODE_KIND_LABEL.sticky).toBe('Sticky note')
    expect(KIND_ICON.sticky).toBe('note')
    expect(nodeRowLabel(sticky)).toBe('Fix login')
    expect(nodeRowLabel({ id: 'e', kind: 'sticky', x: 0, y: 0 })).toBe('Sticky note')
  })

  it('shows its own paper color on the mini-map', () => {
    const node = (stickyColor?: string) => ({ id: 's', type: 'sticky', position: { x: 0, y: 0 }, data: { stickyColor } }) as Node
    expect(miniMapNodeColor(node('blue'), {})).toBe(stickyHex('blue'))
    expect(miniMapNodeColor(node(undefined), {})).toBe(stickyHex('lemon'))
  })

  it('the canvas menu offers "Add sticky note" only when wired, and it runs the handler', () => {
    const addSticky = vi.fn()
    const handlers = { addTerminal: vi.fn(), addAgent: vi.fn(), addFiles: vi.fn(), fitView: vi.fn() }
    const ctx = { nodeCount: 0, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
    expect(buildCanvasMenuRows(handlers, ctx).some((r) => 'key' in r && r.key === 'sticky')).toBe(false)
    const row = buildCanvasMenuRows({ ...handlers, addSticky }, ctx).find((r) => 'key' in r && r.key === 'sticky')
    expect(row && 'label' in row && row.label).toBe('Add sticky note')
    if (row && 'onClick' in row) row.onClick?.()
    expect(addSticky).toHaveBeenCalledOnce()
  })
})

describe('sticky.new command', () => {
  const base = Object.fromEntries(['openOmnibox', 'openQuickOpen', 'openFindInFiles', 'openShortcuts', 'openSettings', 'newTerminal', 'newFiles', 'fitView', 'toggleMaximizeNode', 'toggleSessions', 'toggleChat', 'toggleSecondarySideBar', 'toggleBoard'].map((k) => [k, () => undefined])) as unknown as AppCommandDeps

  it('exists only when the board wires newSticky, runs it, and its chord is unique', () => {
    expect(appCommands(base).some((c) => c.id === 'sticky.new')).toBe(false)
    const newSticky = vi.fn()
    const list = appCommands({ ...base, newSticky })
    const cmd = list.find((c) => c.id === 'sticky.new')
    expect(cmd).toMatchObject({ label: 'Sticky: New Sticky Note', defaultKey: STICKY_NEW_KEY })
    cmd?.run?.()
    expect(newSticky).toHaveBeenCalledOnce()
    expect(list.filter((c) => c.defaultKey === STICKY_NEW_KEY)).toHaveLength(1)
    // Needs a modifier: a bare key would fire while typing in a note.
    expect(STICKY_NEW_KEY).toMatch(/^(Mod|Ctrl|Alt)\+/)
  })
})

describe('last color', () => {
  it('is remembered, falls back to the default for junk, and survives blocked storage', () => {
    localStorage.clear()
    expect(getLastStickyColor()).toBe('lemon')
    setLastStickyColor('cyan')
    expect(getLastStickyColor()).toBe('cyan')
    localStorage.setItem('webterm.sticky.lastColor', 'nope')
    expect(getLastStickyColor()).toBe('lemon')
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(getLastStickyColor()).toBe('lemon')
    expect(() => setLastStickyColor('pink')).not.toThrow()
    get.mockRestore(); set.mockRestore()
    expect(STICKY_COLORS).toHaveLength(10)
  })
})

describe('font', () => {
  it('is imported once, globally, from the local stylesheet', () => {
    const main = readFileSync(join(__dirname, 'main.tsx'), 'utf8')
    expect(main).toContain("import './fonts/sticky.font.css'")
  })
})
