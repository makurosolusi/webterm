/** @vitest-environment jsdom */
// Tab-layout commands in the registry: the toggle, mode-gated tab shortcuts, the canvas guard,
// chord conflicts, and the persistence wiring (store writer -> active workspace payload + save).
import { act, renderHook } from '@testing-library/react'
import type { ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'
import { connectWorkspaceLayout } from './App.tabs'
import { useCanvasViewport } from './canvasViewport'
import { eventChord, findConflicts, listCommands, normalizeChord, type Command } from './commandRegistry'
import { FIXED_COMMANDS, LAYERS_GROUP_KEY, LAYERS_UNGROUP_KEY, appCommands } from './commandRegistry.defaults'
import { TOGGLE_LAYOUT_ID, tabLayoutCommands, toggleLayoutMode, useTabLayoutCommands } from './tabLayout.commands'
import { activateTab, connectTabLayout, getTabLayout, setMode } from './tabLayout.store'
import { terminalKeyAction } from './terminalKeys'

vi.mock('./osNotify', () => ({ setNotifyCanvas: vi.fn(() => () => {}) }))

const ORDER = ['a', 'b', 'c']
const seed = (mode: 'canvas' | 'tabs'): void => {
  const base = defaultTabLayout()
  connectTabLayout({ mode, tabs: { ...base.tabs, order: ORDER, active: 'a' } }, null)
}
const byId = (list: Command[], id: string): Command => list.find((c) => c.id === id) as Command

beforeEach(() => vi.stubGlobal('requestAnimationFrame', () => 0))
afterEach(() => { vi.unstubAllGlobals(); connectTabLayout(defaultTabLayout(), null) })

describe('layout toggle', () => {
  it('the registered command flips canvas <-> tabs', () => {
    seed('canvas')
    const toggle = byId(tabLayoutCommands(vi.fn(), false, true), TOGGLE_LAYOUT_ID)
    expect(toggle.label).toBe('View: Toggle Tab Layout')
    toggle.run?.()
    expect(getTabLayout().mode).toBe('tabs')
    toggle.run?.()
    expect(getTabLayout().mode).toBe('canvas')
  })

  it('is registered with the hook in both modes, the tab shortcuts only in tabs mode', () => {
    seed('canvas')
    const { unmount } = renderHook(() => useTabLayoutCommands(vi.fn()))
    expect(listCommands().some((c) => c.id === TOGGLE_LAYOUT_ID)).toBe(true)
    expect(listCommands().some((c) => c.id === 'tab.goto.1')).toBe(false)
    act(() => toggleLayoutMode())
    expect(listCommands().some((c) => c.id === 'tab.goto.1')).toBe(true)
    act(() => toggleLayoutMode())
    expect(listCommands().some((c) => c.id === 'tab.goto.1')).toBe(false)
    unmount()
    expect(listCommands().some((c) => c.id === TOGGLE_LAYOUT_ID)).toBe(false)
  })
})

describe('tab shortcuts', () => {
  it('Mod+N activates the Nth tab only in tabs mode', () => {
    seed('canvas')
    const list = tabLayoutCommands(vi.fn(), true, true)
    byId(list, 'tab.goto.2').run?.()
    expect(getTabLayout().tabs.active).toBe('a') // canvas mode: no-op even if the command is invoked
    setMode('tabs')
    byId(list, 'tab.goto.2').run?.()
    expect(getTabLayout().tabs.active).toBe('b')
    byId(list, 'tab.goto.9').run?.() // out of range
    expect(getTabLayout().tabs.active).toBe('b')
    expect(byId(list, 'tab.goto.3').defaultKey).toBe('Mod+3')
  })

  it('next/prev wrap around', () => {
    seed('tabs')
    const list = tabLayoutCommands(vi.fn(), true, true)
    byId(list, 'tab.prev').run?.()
    expect(getTabLayout().tabs.active).toBe('c')
    byId(list, 'tab.next').run?.()
    expect(getTabLayout().tabs.active).toBe('a')
  })

  it('close goes through the injected close path with the active tab id', () => {
    seed('tabs')
    activateTab('c')
    const close = vi.fn()
    const { unmount } = renderHook(() => useTabLayoutCommands(close))
    listCommands().find((c) => c.id === 'tab.close')?.run?.()
    expect(close).toHaveBeenCalledWith('c')
    unmount()
  })

  it('close key is the bare Mod+W on macOS only', () => {
    expect(byId(tabLayoutCommands(vi.fn(), true, true), 'tab.close').defaultKey).toBe('Mod+W')
    expect(byId(tabLayoutCommands(vi.fn(), true, false), 'tab.close').defaultKey).toBe('Mod+Alt+W')
  })
})

describe('chords', () => {
  const base = { newTerminal: vi.fn(), newFiles: vi.fn(), newDiff: vi.fn(), newBrowser: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(), toggleSessions: vi.fn(), toggleChat: vi.fn(), toggleSecondarySideBar: vi.fn(), toggleBoard: vi.fn() }
  it.each([true, false])('no default-key conflict with the built-ins (isMac=%s)', (isMac) => {
    const layers: Command[] = [
      { id: 'layers.group', label: 'Layers: Group Selection', defaultKey: LAYERS_GROUP_KEY },
      { id: 'layers.ungroup', label: 'Layers: Ungroup', defaultKey: LAYERS_UNGROUP_KEY },
    ]
    const all = [...appCommands(base), ...FIXED_COMMANDS, ...tabLayoutCommands(vi.fn(), true, isMac), ...layers]
    expect([...findConflicts(all, {}).keys()]).toEqual([])
  })

  it('Toggle Side Bar is Mod+Shift+\\ and ⇧⌘\\ (key "|") resolves to it', () => {
    const cmd = byId(appCommands(base), 'view.sessions')
    expect(cmd.label).toBe('View: Toggle Side Bar')
    expect(cmd.defaultKey).toBe('Mod+Shift+\\')
    const e = { key: '|', code: 'Backslash', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(eventChord(e, true)).toBe(normalizeChord(cmd.defaultKey!))
    expect([LAYERS_GROUP_KEY, LAYERS_UNGROUP_KEY]).toEqual(['Mod+G', 'Mod+Shift+G'])
  })

  it('the node tab strip toggle command is gone', () => {
    for (const tabsMode of [true, false]) expect(tabLayoutCommands(vi.fn(), tabsMode, true).some((c) => c.id === 'view.nodeTabs.toggle')).toBe(false)
  })

  it('bracket chords resolve by physical key even with Shift held', () => {
    const e = { key: '{', code: 'BracketLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(eventChord(e, true)).toBe('Mod+Shift+[')
  })

  it('xterm lets the layout chords bubble to the window dispatcher', () => {
    const ev = (code: string, o: object) => ({ type: 'keydown', key: '', code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })
    const MAC = { isMac: true, isWindows: false }
    const LINUX = { isMac: false, isWindows: false }
    const mac = tabLayoutCommands(vi.fn(), true, true)
    const linux = tabLayoutCommands(vi.fn(), true, false)
    expect(terminalKeyAction(ev('KeyL', { ctrlKey: true, shiftKey: true, key: 'L' }), 'app-first', LINUX, linux, {})).toBe('bubble')
    expect(terminalKeyAction(ev('KeyW', { metaKey: true }), 'app-first', MAC, mac, {})).toBe('bubble')
    expect(terminalKeyAction(ev('KeyW', { ctrlKey: true }), 'app-first', LINUX, linux, {})).toBe('pass') // Ctrl+W stays readline's
    expect(terminalKeyAction(ev('KeyW', { ctrlKey: true, altKey: true }), 'app-first', LINUX, linux, {})).toBe('bubble')
    expect(terminalKeyAction(ev('BracketRight', { metaKey: true, shiftKey: true, key: '}' }), 'app-first', MAC, mac, {})).toBe('bubble')
    expect(terminalKeyAction(ev('Digit2', { ctrlKey: true, key: '2' }), 'app-first', LINUX, linux, {})).toBe('bubble') // tab.goto.2
  })
})

describe('canvas guard', () => {
  const mountViewport = () => {
    const fake = { fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), setViewport: vi.fn(), getViewport: vi.fn(() => DEFAULT_VIEWPORT) }
    const rf = { current: fake as unknown as ReactFlowInstance }
    const hook = renderHook(() => useCanvasViewport({ rf, viewportRef: { current: DEFAULT_VIEWPORT }, scheduleSave: vi.fn() }))
    return { fake, hook }
  }

  it('Fit View, zoom and history do nothing in tabs mode and work again in canvas mode', () => {
    const { fake, hook } = mountViewport()
    seed('tabs')
    act(() => { hook.result.current.onFit(); hook.result.current.onZoomIn(); hook.result.current.onZoomOut(); hook.result.current.onZoomTo(50); hook.result.current.onBack(); hook.result.current.onForward() })
    expect(fake.fitView).not.toHaveBeenCalled()
    expect(fake.zoomIn).not.toHaveBeenCalled()
    expect(fake.zoomOut).not.toHaveBeenCalled()
    expect(fake.zoomTo).not.toHaveBeenCalled()
    expect(fake.setViewport).not.toHaveBeenCalled()
    setMode('canvas')
    act(() => hook.result.current.onFit())
    expect(fake.fitView).toHaveBeenCalledTimes(1)
  })
})

describe('layout persistence', () => {
  const ws = (id: string, layout?: Workspace['layout']): Workspace => ({ id, name: id, cwd: '/', nodes: [], bridges: [], viewport: DEFAULT_VIEWPORT, updatedAt: 0, layout })

  it('a mode change reaches the active workspace payload and schedules a save', () => {
    const w = ws('w1')
    const ref = { current: w as Workspace | null }
    const scheduleSave = vi.fn()
    connectWorkspaceLayout(w, ref, scheduleSave)
    setMode('tabs')
    expect(ref.current?.layout?.mode).toBe('tabs')
    expect(scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('a workspace without a layout starts as canvas; a stored layout is restored', () => {
    connectWorkspaceLayout(ws('w1'), { current: null }, vi.fn())
    expect(getTabLayout().mode).toBe('canvas')
    connectWorkspaceLayout(ws('w2', { mode: 'tabs', tabs: { order: ['x'], active: 'x', filesPanel: { open: false, width: 300 }, groups: [] } }), { current: null }, vi.fn())
    expect(getTabLayout().mode).toBe('tabs')
    expect(getTabLayout().tabs.active).toBe('x')
  })

  it('a writer left over from the previous workspace never stamps the new one', () => {
    const w1 = ws('w1')
    const ref = { current: w1 as Workspace | null }
    const save1 = vi.fn()
    connectWorkspaceLayout(w1, ref, save1)
    ref.current = ws('w2') // the board switched but the store is not re-pointed yet
    setMode('tabs')
    expect(save1).not.toHaveBeenCalled()
    expect(ref.current?.layout).toBeUndefined()
  })

  it('after re-connecting, edits land on the new workspace only', () => {
    const ref = { current: ws('w1') as Workspace | null }
    connectWorkspaceLayout(ref.current as Workspace, ref, vi.fn())
    const w2 = ws('w2')
    ref.current = w2
    const save2 = vi.fn()
    connectWorkspaceLayout(w2, ref, save2)
    setMode('tabs')
    expect(save2).toHaveBeenCalledTimes(1)
    expect(ref.current?.layout?.mode).toBe('tabs')
  })
})
