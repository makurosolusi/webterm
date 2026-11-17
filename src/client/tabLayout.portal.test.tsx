/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import type { NodeProps } from '@xyflow/react'
import { ReactFlow, ReactFlowProvider, useNodeId } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTabLayout, setMode, activateTab } from './tabLayout.store'
import { useNodeHost } from './tabLayout.context'
import { getNodeHost, placeNodeHost } from './tabLayout.dom'
import { withTabPortal } from './tabLayout.portal'
import { nodeTypes } from './nodeTypes'
import { defaultTabLayout } from '../shared/tabLayout.schema'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; ResizeObserver?: never }
g.IS_REACT_ACT_ENVIRONMENT = true

const probe = { mounts: 0, connectedAtEffect: undefined as boolean | undefined, data: undefined as unknown, host: undefined as unknown, nodeId: undefined as unknown }
function Probe(p: NodeProps) {
  const host = useNodeHost()
  const nodeId = useNodeId()
  useEffect(() => { probe.mounts++; probe.connectedAtEffect = getNodeHost(p.id).isConnected }, [p.id])
  probe.data = p.data
  probe.host = host
  probe.nodeId = nodeId
  return <span data-testid="inner">{p.id}</span>
}
const Wrapped = withTabPortal(Probe)
const props = (data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): NodeProps =>
  ({ id: 'n1', type: 'terminal', data, selected: false, ...extra }) as unknown as NodeProps

function Shell({ children }: { children: ReactNode }) {
  return <ReactFlowProvider><div data-testid="pane" />{children}</ReactFlowProvider>
}

beforeEach(() => {
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  probe.mounts = 0
  connectTabLayout({ ...defaultTabLayout(), tabs: { ...defaultTabLayout().tabs, order: ['n1'], active: 'n1' } }, null)
})
afterEach(() => { cleanup(); connectTabLayout(undefined, null) })

describe('withTabPortal', () => {
  it('connects the host before the first child effect and fills the canvas slot', () => {
    const { container } = render(<Shell><Wrapped {...props()} /></Shell>)
    expect(probe.connectedAtEffect).toBe(true)
    const slot = container.querySelector('.tab-host-slot')!
    expect(slot.firstChild).toBe(getNodeHost('n1'))
    expect(slot.querySelector('[data-testid=inner]')).not.toBeNull()
    expect(probe.nodeId).toBeNull() // outside a real RF node: portal keeps the React tree, see real-flow test
  })

  it('moves host canvas -> pane -> canvas without remounting Inner', () => {
    const { container, getByTestId } = render(<Shell><Wrapped {...props()} /></Shell>)
    const slot = container.querySelector('.tab-host-slot')!
    const host = getNodeHost('n1')
    for (let i = 0; i < 5; i++) {
      act(() => setMode('tabs'))
      expect(host.parentNode).toBe(slot) // HOC leaves tabs placement to the tab view
      act(() => placeNodeHost('n1', getByTestId('pane')))
      expect(host.parentNode).toBe(getByTestId('pane'))
      act(() => setMode('canvas'))
      expect(host.parentNode).toBe(slot)
    }
    expect(probe.mounts).toBe(1)
    expect(getNodeHost('n1')).toBe(host)
  })

  it('reports inTab/visible through context', () => {
    render(<Shell><Wrapped {...props()} /></Shell>)
    expect(probe.host).toEqual({ inTab: false, visible: true, maximized: false })
    act(() => setMode('tabs'))
    expect(probe.host).toEqual({ inTab: true, visible: true, maximized: false })
    act(() => connectTabLayout({ ...defaultTabLayout(), mode: 'tabs', tabs: { ...defaultTabLayout().tabs, order: ['n1', 'n2'], active: 'n2' } }, null))
    expect(probe.host).toEqual({ inTab: true, visible: false, maximized: false })
    act(() => activateTab('n1'))
    expect(probe.host).toEqual({ inTab: true, visible: true, maximized: false })
  })

  it('files node visibility follows the files panel in tab mode', () => {
    const tabs = defaultTabLayout().tabs
    act(() => connectTabLayout({ ...defaultTabLayout(), mode: 'tabs', tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, open: false } } }, null))
    render(<Shell><Wrapped {...props({}, { id: 'f1', type: 'files' })} /></Shell>)
    expect(probe.host).toEqual({ inTab: true, visible: false, maximized: false })
    act(() => connectTabLayout({ ...defaultTabLayout(), mode: 'tabs', tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, open: true } } }, null))
    expect((probe.host as { visible: boolean }).visible).toBe(true)
  })

  it('overrides collapsed/maximized only in tab mode without mutating node data', () => {
    const data = { collapsed: true, maximized: true, title: 't' }
    render(<Shell><Wrapped {...props(data)} /></Shell>)
    expect(probe.data).toBe(data)
    act(() => setMode('tabs'))
    expect(probe.data).toEqual({ collapsed: false, maximized: false, title: 't' })
    expect(data).toEqual({ collapsed: true, maximized: true, title: 't' })
    act(() => setMode('canvas'))
    expect(probe.data).toBe(data)
  })

  it('releases the host on unmount', () => {
    const { unmount } = render(<Shell><Wrapped {...props()} /></Shell>)
    const host = getNodeHost('n1')
    unmount()
    expect(host.isConnected).toBe(false)
    expect(getNodeHost('n1')).not.toBe(host)
  })

  it('stops synthetic bubbling only in tab mode, never the native event', () => {
    const parentClick = vi.fn()
    const winClick = vi.fn()
    window.addEventListener('click', winClick)
    const { getByTestId } = render(<Shell><div onClick={parentClick}><Wrapped {...props()} /></div></Shell>)
    fireEvent.click(getByTestId('inner'))
    expect(parentClick).toHaveBeenCalledTimes(1) // canvas mode: guard off
    act(() => setMode('tabs'))
    parentClick.mockClear(); winClick.mockClear()
    fireEvent.click(getByTestId('inner'))
    expect(parentClick).not.toHaveBeenCalled()
    expect(winClick).toHaveBeenCalledTimes(1)
    window.removeEventListener('click', winClick)
  })

  it('keeps the node id available inside a real React Flow node', () => {
    const Tid = withTabPortal(function T(p) { probe.nodeId = useNodeId(); return <i>{p.id}</i> })
    const types = { t: Tid }
    render(
      <div style={{ width: 400, height: 300 }}>
        <ReactFlow nodeTypes={types} nodes={[{ id: 'rf1', type: 't', position: { x: 0, y: 0 }, data: {} }]} edges={[]} />
      </div>,
    )
    expect(probe.nodeId).toBe('rf1')
  })

  // Claude view switch: the server flips a node's kind (agent <-> agentChat), so React Flow swaps the
  // component under the SAME id. The old portal's unmount must not take the new one's host with it.
  it('keeps the host on the canvas when a node changes type under the same id', () => {
    const A = withTabPortal(function A() { return <i data-testid="view-a" /> })
    const B = withTabPortal(function B() { return <i data-testid="view-b" /> })
    // React Flow renders `nodeTypes[type]` in the node's slot: a new type is a new component there.
    const flow = (type: 'a' | 'b') => {
      const T = type === 'a' ? A : B
      return <Shell><T {...props({}, { id: 'sw1', type })} /></Shell>
    }
    const { rerender, container } = render(flow('a'))
    expect(container.querySelector('[data-testid=view-a]')).not.toBeNull()
    rerender(flow('b'))
    const host = getNodeHost('sw1')
    expect(host.isConnected).toBe(true)
    expect(container.querySelector('.tab-host-slot')?.firstChild).toBe(host)
    expect(container.querySelector('[data-testid=view-b]')).not.toBeNull()
    expect(container.querySelector('[data-testid=view-a]')).toBeNull()
  })

  it('exposes the ten node types as stable module constants', () => {
    expect(Object.keys(nodeTypes).sort()).toEqual(['agent', 'agentChat', 'app', 'browser', 'diff', 'editor', 'files', 'plan', 'skill', 'terminal'])
    Object.values(nodeTypes).forEach((t) => expect(t).toBeTruthy())
  })
})

