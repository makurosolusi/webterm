/** @vitest-environment jsdom */
// Maximize fills the canvas pane by moving the node's persistent host into one overlay slot
// (VS Code "Maximize Editor Group"), never the OS full screen, never zooming the viewport.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useEffect } from 'react'
import { ReactFlow, useReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'
import NodeMaximizeOverlay from './nodeMaximize.overlay'
import { getMaximizedNode, setMaximizedNode, toggleMaximizeTarget } from './nodeMaximize.store'
import { getNodeHost } from './tabLayout.dom'
import { withTabPortal } from './tabLayout.portal'
import { connectTabLayout, setMode } from './tabLayout.store'
import { defaultTabLayout } from '../shared/tabLayout.schema'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; ResizeObserver?: never }
g.IS_REACT_ACT_ENVIRONMENT = true

const mounts: Record<string, number> = {}
const chrome = {
  onRename: () => {}, collapsed: false, onToggleCollapse: () => {}, color: '#fff', onColor: () => {},
  comments: [], onAddComment: () => {}, onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {}, onClose: () => {},
}
const T = withTabPortal(function T(p: NodeProps) {
  useEffect(() => { mounts[p.id] = (mounts[p.id] ?? 0) + 1 }, [p.id])
  return <div className="term-node"><NodeChrome title={p.id} {...chrome} /><i data-testid={`body-${p.id}`} /></div>
})
const types = { t: T }
const mk = (id: string, x: number, selected = false): Node => ({ id, type: 't', position: { x, y: 10 }, data: {}, selected })

// onInit waits for measured nodes, which jsdom never has; read the instance from inside the flow instead.
let rf: ReactFlowInstance | undefined
function Grab() { rf = useReactFlow(); return null }
function Board({ nodes }: { nodes: Node[] }) {
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodeTypes={types} nodes={nodes} edges={[]}>
        <Grab />
        <NodeMaximizeOverlay nodes={nodes} />
      </ReactFlow>
    </div>
  )
}
const two = [mk('a', 0), mk('b', 300)]
const header = (id: string) => getNodeHost(id).querySelector('.node-header') as HTMLElement
const button = (id: string, title: string) => getNodeHost(id).querySelector(`[data-title="${title}"]`) as HTMLElement | null
const icon = (id: string) => [...getNodeHost(id).querySelectorAll('.codicon')].map((i) => i.className).find((c) => c.includes('screen-'))
const overlay = () => document.querySelectorAll('.node-maximize')

beforeEach(() => {
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  for (const k of Object.keys(mounts)) delete mounts[k]
  connectTabLayout(defaultTabLayout(), null)
})
afterEach(() => { cleanup(); setMaximizedNode(null); connectTabLayout(undefined, null) })

describe('node maximize', () => {
  it('moves the same host into the overlay and back, without remounting, and swaps the button', () => {
    render(<Board nodes={two} />)
    const host = getNodeHost('a')
    const slot = host.parentElement
    expect(slot?.className).toBe('tab-host-slot')
    expect(button('a', 'Maximize')).not.toBeNull()
    expect(icon('a')).toContain('codicon-screen-full')
    act(() => { button('a', 'Maximize')!.click() })
    expect(overlay()).toHaveLength(1)
    expect(host.parentElement).toBe(overlay()[0])
    expect(overlay()[0].getAttribute('data-id')).toBe('a')
    expect(button('a', 'Restore')).not.toBeNull()
    expect(icon('a')).toContain('codicon-screen-normal')
    act(() => { button('a', 'Restore')!.click() })
    expect(overlay()).toHaveLength(0)
    expect(getNodeHost('a')).toBe(host)
    expect(host.parentElement).toBe(slot)
    expect(button('a', 'Maximize')).not.toBeNull()
    expect(mounts.a).toBe(1)
  })

  it('leaves the viewport and the node position untouched', () => {
    render(<Board nodes={two} />)
    const vp = rf!.getViewport()
    const pos = { ...rf!.getNode('a')!.position }
    act(() => setMaximizedNode('a'))
    expect(rf!.getViewport()).toEqual(vp)
    expect(rf!.getNode('a')!.position).toEqual(pos)
    act(() => setMaximizedNode(null))
    expect(rf!.getViewport()).toEqual(vp)
    expect(rf!.getNode('a')!.position).toEqual(pos)
  })

  it('keeps at most one node maximized: maximizing another replaces it', () => {
    render(<Board nodes={two} />)
    const aSlot = getNodeHost('a').parentElement
    act(() => setMaximizedNode('a'))
    act(() => { button('b', 'Maximize')!.click() })
    expect(overlay()).toHaveLength(1)
    expect(overlay()[0].getAttribute('data-id')).toBe('b')
    expect(getNodeHost('a').parentElement).toBe(aSlot)
    expect(getMaximizedNode()).toBe('b')
  })

  it('clears when the maximized node is deleted', () => {
    const { rerender } = render(<Board nodes={two} />)
    act(() => setMaximizedNode('a'))
    rerender(<Board nodes={[two[1]]} />)
    expect(getMaximizedNode()).toBeNull()
    expect(overlay()).toHaveLength(0)
  })

  it('clears when the board unmounts (workspace switch)', () => {
    const { unmount } = render(<Board nodes={two} />)
    act(() => setMaximizedNode('a'))
    unmount()
    expect(getMaximizedNode()).toBeNull()
  })

  it('clears on a switch to tab layout and hides the button there', () => {
    render(<Board nodes={two} />)
    act(() => setMaximizedNode('a'))
    act(() => setMode('tabs'))
    expect(getMaximizedNode()).toBeNull()
    expect(overlay()).toHaveLength(0)
    expect(button('a', 'Maximize')).toBeNull()
    expect(button('a', 'Restore')).toBeNull()
  })

  it('toggles on a header double-click, but not on a double-click of a header button', () => {
    render(<Board nodes={two} />)
    act(() => { fireEvent.doubleClick(button('a', 'Search')!) })
    expect(getMaximizedNode()).toBeNull()
    act(() => { fireEvent.doubleClick(header('a')) })
    expect(getMaximizedNode()).toBe('a')
    act(() => { fireEvent.doubleClick(header('a')) })
    expect(getMaximizedNode()).toBeNull()
  })
})

describe('Toggle Maximize Node command', () => {
  it('restores the maximized node, else maximizes the sole selected node; no-op in tab mode', () => {
    toggleMaximizeTarget([mk('a', 0, true), mk('b', 0, true)])
    expect(getMaximizedNode()).toBeNull() // two selected, nothing focused: no target
    toggleMaximizeTarget([mk('a', 0), mk('b', 0, true)])
    expect(getMaximizedNode()).toBe('b')
    toggleMaximizeTarget([mk('a', 0, true)])
    expect(getMaximizedNode()).toBeNull()
    setMode('tabs')
    toggleMaximizeTarget([mk('a', 0, true)])
    expect(getMaximizedNode()).toBeNull()
  })
})

describe('node files share the one maximize', () => {
  it.each(['AgentNode', 'AgentChatNode', 'BrowserNode', 'FilesNode', 'TerminalNode'])('%s has no own fitView/fullscreen maximize', (name) => {
    const src = readFileSync(resolve(process.cwd(), `src/client/${name}.tsx`), 'utf8')
    expect(src).not.toMatch(/fitView|setMaximized|useNodeFullscreen|onToggleMaximize|requestFullscreen/)
  })
})
