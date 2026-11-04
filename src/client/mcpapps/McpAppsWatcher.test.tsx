/** @vitest-environment jsdom */
// App node placement: `mcpapp.published` on the events SSE stream claims and places apps (no 3 s poll);
// a refused stream (ledger off) falls back to the slow poll. Also pins the node-type registration.
import { act, cleanup, render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, useNodesState, type Node } from '@xyflow/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAppView: vi.fn(), callAppTool: vi.fn(), claimApps: vi.fn() }))
vi.mock('./mcpApp.api', () => api)

import McpAppsWatcher, { APP_FALLBACK_POLL_MS, APP_STREAM_URL, appNodeFor } from './McpAppsWatcher'

// test-only: a controllable EventSource
class FakeSource {
  static CLOSED = 2
  static last: FakeSource | null = null
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, (() => void)[]> = {}
  constructor(public url: string) { FakeSource.last = this }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn) }
  emit(type: string) { for (const fn of this.listeners[type] ?? []) fn() }
  close = vi.fn()
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
beforeEach(() => { vi.stubGlobal('EventSource', FakeSource); FakeSource.last = null })
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

let latest: Node[] = []
function Canvas() {
  const [nodes, , onNodesChange] = useNodesState<Node>([{ id: 'a1', type: 'default', position: { x: 100, y: 50 }, width: 300, height: 200, data: {} }])
  latest = nodes
  return <div style={{ width: 800, height: 600 }}><ReactFlow nodes={nodes} onNodesChange={onNodesChange}><McpAppsWatcher /></ReactFlow></div>
}
const mount = () => render(<ReactFlowProvider><Canvas /></ReactFlowProvider>)
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('McpAppsWatcher', () => {
  it('subscribes to mcpapp.published only and places a published app beside its owner', async () => {
    api.claimApps.mockResolvedValue({ apps: [] })
    mount()
    await flush()
    expect(FakeSource.last?.url).toBe(APP_STREAM_URL)
    expect(APP_STREAM_URL).toBe('/api/events/stream?kind=mcpapp.published')
    api.claimApps.mockResolvedValue({ apps: [{ id: 'app-1', ownerNodeId: 'a1', uri: 'ui://x' }] })
    await act(async () => { FakeSource.last?.emit('sense') })
    await flush()
    expect(api.claimApps).toHaveBeenLastCalledWith(['a1'])
    const app = latest.find((n) => n.id === 'app-1')
    expect(app).toMatchObject({ type: 'app', position: { x: 440, y: 50 } })
  })

  it('does not poll while the stream is up, and polls slowly once it is refused', async () => {
    vi.useFakeTimers()
    api.claimApps.mockResolvedValue({ apps: [] })
    mount()
    await flush()
    const base = api.claimApps.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(APP_FALLBACK_POLL_MS * 2) })
    expect(api.claimApps.mock.calls.length).toBe(base)
    const s = FakeSource.last as FakeSource
    s.readyState = FakeSource.CLOSED
    act(() => s.onerror?.())
    await act(async () => { vi.advanceTimersByTime(APP_FALLBACK_POLL_MS) })
    expect(api.claimApps.mock.calls.length).toBe(base + 1)
  })

  it('appNodeFor falls back to the origin when the owner is not on the canvas', () => {
    expect(appNodeFor({ id: 'app-2', ownerNodeId: 'gone' }, undefined).position).toEqual({ x: 0, y: 0 })
  })
})

describe('node type registration', () => {
  it('nodeTypes maps kind "app" to the App node', async () => {
    const [{ nodeTypes }, { default: McpAppNode }] = await Promise.all([import('../nodeTypes'), import('./McpAppNode')])
    expect(nodeTypes.app).toBe(McpAppNode)
  })
})
