/** @vitest-environment jsdom */
// App node DOM: the view frame is a sandboxed srcdoc (scripts, no same-origin), and only messages from
// that frame reach the bridge. The `/api/mcpapps` client is faked.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'

const api = vi.hoisted(() => ({ fetchAppView: vi.fn(), callAppTool: vi.fn(), claimApps: vi.fn() }))
vi.mock('./mcpApp.api', () => api)

import McpAppNode, { APP_TEXT } from './McpAppNode'
import { NodeHostContext } from '../tabLayout.context'
import { expectSharedChrome } from '../nodeChromeKinds.testkit'
import { setEditorActionsSlot, tabNodeMenuItems } from '../tabLayout.nodeActions'

// test-only: jsdom has no ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

// test-only view
const VIEW = { id: 'app-1', uri: 'ui://weather/forecast', ownerNodeId: 'a1', csp: "default-src 'none'", html: '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><p>hi</p>', permissions: ['camera'] }
const mount = (inTab = false) => render(
  <ReactFlowProvider>
    <div ref={setEditorActionsSlot} data-slot="tab-editor-actions" />
    <NodeHostContext.Provider value={{ inTab, visible: true, maximized: false }}>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodes={[{ id: 'app-1', type: 'app', position: { x: 0, y: 0 }, width: 480, height: 360, data: {} } satisfies Node]} nodeTypes={{ app: McpAppNode }} />
      </div>
    </NodeHostContext.Provider>
  </ReactFlowProvider>,
)

describe('McpAppNode', () => {
  it('renders the view in an opaque-origin sandboxed srcdoc frame with the requested permissions', async () => {
    api.fetchAppView.mockResolvedValue(VIEW)
    mount()
    const frame = await screen.findByTitle(APP_TEXT.frameTitle) as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe(VIEW.html)
    expect(frame.getAttribute('src')).toBeNull()
    expect(frame.getAttribute('allow')).toBe('camera')
    expect(api.fetchAppView).toHaveBeenCalledWith('app-1')
  })

  it('answers the frame over the bridge and ignores the same message from any other window', async () => {
    api.fetchAppView.mockResolvedValue(VIEW)
    mount()
    const frame = await screen.findByTitle(APP_TEXT.frameTitle) as HTMLIFrameElement
    const win = frame.contentWindow as Window
    const post = vi.spyOn(win, 'postMessage')
    const init = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }
    window.dispatchEvent(new MessageEvent('message', { data: init, source: window }))
    window.dispatchEvent(new MessageEvent('message', { data: init, source: win }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toMatchObject({ id: 1, result: { protocolVersion: '2026-01-26' } })
  })

  it('says so when the app is gone (server restarted)', async () => {
    api.fetchAppView.mockRejectedValue(Object.assign(new Error('Load app: app_not_found'), { status: 404 }))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe(APP_TEXT.gone)
  })
})

describe('McpAppNode in tab mode', () => {
  const slot = () => document.querySelector<HTMLElement>('[data-slot="tab-editor-actions"]')!
  it('renders no own header or close (the tab × closes it) and adds no strip buttons', async () => {
    api.fetchAppView.mockResolvedValue(VIEW)
    const { container } = mount(true)
    await screen.findByTitle(APP_TEXT.frameTitle)
    expect(container.querySelector('.mcp-app-node .node-header')).toBeNull()
    expect(container.querySelector('.mcp-app-node .codicon-close')).toBeNull()
    expect(slot().querySelectorAll('button')).toHaveLength(0)
    expect(tabNodeMenuItems('app-1')).toEqual([])
  })

  it('on the canvas uses the shared NodeChrome header: the app uri as title, no resize button, edges resize', async () => {
    api.fetchAppView.mockResolvedValue(VIEW)
    const { container } = mount()
    await screen.findByTitle(APP_TEXT.frameTitle)
    expect(container.querySelector('.mcp-app-node .node-header .node-title')?.textContent).toBe(VIEW.uri)
    expect(container.querySelector('.mcp-app-node .node-header .node-icon.codicon-window')).not.toBeNull()
    expectSharedChrome(container.querySelector('.react-flow__node[data-id="app-1"]')!)
  })
})
