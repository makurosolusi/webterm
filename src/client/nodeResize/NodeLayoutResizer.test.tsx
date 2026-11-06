/** @vitest-environment jsdom */
// Resize mode is explicit: selection never shows handles; the header toggle or the command does,
// and Esc, an outside press, typing in the node, collapse, removal and the view lock end it.
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NodeLayoutResizer, NodeResizeToggle } from './NodeLayoutResizer'
import { exitNodeResize, getNodeResizeState, setNodeResizeLocked, toggleFocusedNodeResize, toggleNodeResize, RESIZE_COMMAND_ID } from './nodeResize.store'
import { appCommands, FIXED_COMMANDS } from '../commandRegistry.defaults'
import { findConflicts, listCommands } from '../commandRegistry'
import { resizeCommand, useNodeResizeWiring } from './useNodeResizeWiring'

// test-only: jsdom has no ResizeObserver; unmeasured nodes are enough here.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); setNodeResizeLocked(false); exitNodeResize() })

// test-only probe node, wired like the real nodes: resizer + header toggle + a typing surface.
function Probe({ data }: NodeProps) {
  const collapsed = Boolean((data as { collapsed?: boolean }).collapsed)
  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} />
      <div className="term-node">
        <div className="node-header"><span>Probe</span><NodeResizeToggle /></div>
        <div className="node-body"><textarea aria-label="input" /></div>
      </div>
    </>
  )
}
const nodeTypes = { probe: Probe }
const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, type: 'probe', position: { x: id === 'a' ? 0 : 600, y: 0 }, width: 400, height: 300, data: {}, ...extra })

function mount(nodes: Node[]) {
  const ui = (ns: Node[]) => <ReactFlowProvider><div style={{ width: 1200, height: 800 }}><ReactFlow nodes={ns} nodeTypes={nodeTypes} /></div></ReactFlowProvider>
  const r = render(ui(nodes))
  return { rerender: (ns: Node[]) => r.rerender(ui(ns)) }
}
const handles = () => document.querySelectorAll('.react-flow__resize-control')
const toggleOf = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-slot="icon-button"]`) as HTMLButtonElement
const textareaOf = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"] textarea`) as HTMLTextAreaElement

describe('NodeLayoutResizer', () => {
  it('shows no handles on a selected or clicked node', () => {
    mount([node('a', { selected: true })])
    fireEvent.click(document.querySelector('.react-flow__node[data-id="a"]')!)
    expect(handles().length).toBe(0)
    expect(toggleOf('a').getAttribute('aria-pressed')).toBe('false')
    expect(toggleOf('a').getAttribute('aria-label')).toBe('Resize this node')
  })

  it('the toggle shows the handles and turns them off again', () => {
    mount([node('a')])
    fireEvent.click(toggleOf('a'))
    expect(handles().length).toBeGreaterThan(0)
    expect(toggleOf('a').getAttribute('aria-pressed')).toBe('true')
    expect(toggleOf('a').getAttribute('aria-label')).toBe('Done resizing')
    fireEvent.pointerDown(toggleOf('a'))
    fireEvent.click(toggleOf('a'))
    expect(handles().length).toBe(0)
  })

  it('Esc exits', () => {
    mount([node('a')])
    fireEvent.click(toggleOf('a'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(handles().length).toBe(0)
  })

  it('a press outside the node exits', () => {
    mount([node('a'), node('b')])
    fireEvent.click(toggleOf('a'))
    fireEvent.pointerDown(textareaOf('b'))
    expect(handles().length).toBe(0)
  })

  it('typing inside the node content exits, a chord does not', () => {
    mount([node('a')])
    fireEvent.click(toggleOf('a'))
    fireEvent.keyDown(textareaOf('a'), { key: 'Shift' })
    fireEvent.keyDown(textareaOf('a'), { key: 'r', metaKey: true, altKey: true })
    expect(handles().length).toBeGreaterThan(0)
    fireEvent.keyDown(textareaOf('a'), { key: 'a' })
    expect(handles().length).toBe(0)
  })

  it('collapse exits', () => {
    const m = mount([node('a')])
    fireEvent.click(toggleOf('a'))
    m.rerender([node('a', { data: { collapsed: true } })])
    expect(handles().length).toBe(0)
    expect(getNodeResizeState().editingId).toBeNull()
  })

  it('removing the node exits', () => {
    const m = mount([node('a'), node('b')])
    fireEvent.click(toggleOf('a'))
    m.rerender([node('b')])
    expect(getNodeResizeState().editingId).toBeNull()
  })

  it('dragging a handle keeps the mode', () => {
    mount([node('a')])
    fireEvent.click(toggleOf('a'))
    const handle = handles()[0] as HTMLElement
    // test-only: jsdom leaves `event.view` null and its constructor rejects vitest's window; d3-drag reads it.
    const mouse = (target: EventTarget, type: string, x: number, y: number) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperty(ev, 'view', { value: window })
      act(() => { target.dispatchEvent(ev) })
    }
    fireEvent.pointerDown(handle)
    mouse(handle, 'mousedown', 400, 300)
    mouse(window, 'mousemove', 450, 340)
    mouse(window, 'mouseup', 450, 340)
    expect(handles().length).toBeGreaterThan(0)
    expect(getNodeResizeState().editingId).toBe('a')
  })

  it('the view lock disables the toggle and exits resize mode', () => {
    mount([node('a')])
    fireEvent.click(toggleOf('a'))
    act(() => setNodeResizeLocked(true))
    expect(handles().length).toBe(0)
    expect(toggleOf('a').disabled).toBe(true)
    fireEvent.click(toggleOf('a'))
    act(() => toggleNodeResize('a'))
    expect(handles().length).toBe(0)
    act(() => setNodeResizeLocked(false))
    expect(toggleOf('a').disabled).toBe(false)
  })

  it('the command toggles the focused node, else the single selected one', () => {
    mount([node('a'), node('b')])
    textareaOf('b').focus()
    act(() => toggleFocusedNodeResize(['a']))
    expect(getNodeResizeState().editingId).toBe('b')
    textareaOf('b').blur()
    act(() => toggleFocusedNodeResize(['a']))
    expect(getNodeResizeState().editingId).toBe('a')
    act(() => toggleFocusedNodeResize(['a']))
    expect(handles().length).toBe(0)
    act(() => toggleFocusedNodeResize(['a', 'b']))
    expect(getNodeResizeState().editingId).toBeNull()
  })

})

describe('useNodeResizeWiring (board wiring)', () => {
  // test-only fake React Flow instance: only getNodes is read.
  const fakeRf = (selected: string[]) => ({ current: { getNodes: () => [{ id: 'x', selected: false }, ...selected.map((id) => ({ id, selected: true }))] } as unknown as ReactFlowInstance })

  it('mirrors the view lock: locking exits resize mode and blocks re-entry, unlocking allows it again', () => {
    act(() => toggleNodeResize('a'))
    const h = renderHook(({ locked }) => useNodeResizeWiring(locked, fakeRf([])), { initialProps: { locked: false } })
    expect(getNodeResizeState()).toEqual({ editingId: 'a', locked: false })
    h.rerender({ locked: true })
    expect(getNodeResizeState()).toEqual({ editingId: null, locked: true })
    act(() => toggleNodeResize('a'))
    expect(getNodeResizeState().editingId).toBeNull()
    h.rerender({ locked: false })
    act(() => toggleNodeResize('a'))
    expect(getNodeResizeState().editingId).toBe('a')
  })

  it('registers "Node: Resize Focused Node" while mounted; it toggles the selected node', () => {
    const h = renderHook(() => useNodeResizeWiring(false, fakeRf(['n1'])))
    const cmd = listCommands().find((c) => c.id === RESIZE_COMMAND_ID)
    expect(cmd?.label).toBe('Node: Resize Focused Node')
    expect(cmd?.defaultKey).toBe('Mod+Alt+R')
    act(() => cmd?.run?.())
    expect(getNodeResizeState().editingId).toBe('n1')
    act(() => cmd?.run?.())
    expect(getNodeResizeState().editingId).toBeNull()
    h.unmount()
    expect(listCommands().some((c) => c.id === RESIZE_COMMAND_ID)).toBe(false)
  })

  it('its default key conflicts with no built-in command', () => {
    const noop = vi.fn()
    const app = appCommands({
      openOmnibox: noop, openQuickOpen: noop, openFindInFiles: noop, openShortcuts: noop, openSettings: noop, newTerminal: noop,
      newFiles: noop, newBrowser: noop, newDiff: noop, fitView: noop, toggleMaximizeNode: noop, toggleSessions: noop, toggleInbox: noop, toggleChat: noop, toggleBoard: noop,
    })
    expect([...findConflicts([...app, ...FIXED_COMMANDS, resizeCommand(() => [])], {}).keys()]).toEqual([])
  })
})
