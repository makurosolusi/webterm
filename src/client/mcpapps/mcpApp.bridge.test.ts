// MCP Apps host bridge (SEP-1865 2026-01-26): handshake, ordering, tools/call proxying, link and error rules.
import { describe, expect, it, vi } from 'vitest'
import { APP_PROTOCOL_VERSION, APP_SANDBOX, BRIDGE_ERR, allowAttribute, createAppBridge, type BridgeHost } from './mcpApp.bridge'

function setup(over: Partial<BridgeHost> = {}) {
  const sent: Record<string, unknown>[] = []
  const host: BridgeHost = {
    post: (m) => sent.push(m),
    callTool: vi.fn(async () => ({ content: [], structuredContent: { outcome: 'ok' }, isError: false })),
    openLink: vi.fn(),
    theme: 'dark',
    toolInput: { city: 'Paris' },
    toolResult: { content: [{ type: 'text', text: 'sunny' }] },
    ...over,
  }
  return { sent, host, bridge: createAppBridge(host) }
}
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params })

describe('mcp app bridge', () => {
  it('answers ui/initialize with the spec version, host info and context, and sends nothing else yet', async () => {
    const { sent, bridge } = setup()
    await bridge.handle(rpc(1, 'ui/initialize', { appCapabilities: {}, protocolVersion: APP_PROTOCOL_VERSION }))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'webterm' }, hostContext: { theme: 'dark', displayMode: 'inline' } } })
    expect((sent[0].result as { hostCapabilities: Record<string, unknown> }).hostCapabilities).toEqual({ serverTools: {}, openLinks: {}, logging: {} })
    expect(bridge.initialized).toBe(false)
  })

  it('sends tool-input then tool-result once, only after ui/notifications/initialized', async () => {
    const { sent, bridge } = setup()
    await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    expect(sent.map((m) => m.method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result'])
    expect(sent[0].params).toEqual({ arguments: { city: 'Paris' } })
    expect(sent[1].params).toEqual({ content: [{ type: 'text', text: 'sunny' }] })
  })

  it('proxies tools/call to the host and returns its CallToolResult under the request id', async () => {
    const { sent, host, bridge } = setup()
    await bridge.handle(rpc(7, 'tools/call', { name: 'cap_search', arguments: { query: 'git' } }))
    expect(host.callTool).toHaveBeenCalledWith('cap_search', { query: 'git' })
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [], structuredContent: { outcome: 'ok' }, isError: false } })
  })

  it('a failing tools/call is a JSON-RPC error naming the tool; a missing name is invalid params', async () => {
    const { sent, bridge } = setup({ callTool: async () => { throw new Error('HTTP 500') } })
    await bridge.handle(rpc(2, 'tools/call', { name: 'git_diff' }))
    await bridge.handle(rpc(3, 'tools/call', {}))
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: BRIDGE_ERR.host, message: 'tools/call git_diff failed: HTTP 500' } })
    expect((sent[1].error as { code: number }).code).toBe(BRIDGE_ERR.invalidParams)
  })

  it('opens only http(s) links and refuses unsupported methods', async () => {
    const { sent, host, bridge } = setup()
    await bridge.handle(rpc(4, 'ui/open-link', { url: 'javascript:alert(1)' }))
    await bridge.handle(rpc(5, 'ui/open-link', { url: 'https://example.com/' }))
    await bridge.handle(rpc(6, 'ui/message', { role: 'user', content: { type: 'text', text: 'hi' } }))
    expect(host.openLink).toHaveBeenCalledTimes(1)
    expect(host.openLink).toHaveBeenCalledWith('https://example.com/')
    expect((sent[0].error as { code: number }).code).toBe(BRIDGE_ERR.host)
    expect(sent[1]).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
    expect((sent[2].error as { code: number }).code).toBe(BRIDGE_ERR.methodNotFound)
  })

  it('ignores non-JSON-RPC data and replies, and tears down only an initialized view', async () => {
    const { sent, bridge } = setup()
    await bridge.handle('hello')
    await bridge.handle({ jsonrpc: '2.0', id: 'teardown-1', result: {} })
    bridge.teardown('closed')
    expect(sent).toHaveLength(0)
    await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    bridge.teardown('closed')
    expect(sent.at(-1)).toMatchObject({ method: 'ui/resource-teardown', params: { reason: 'closed' } })
  })

  it('maps permissions to the allow attribute and never sandboxes with allow-same-origin', () => {
    expect(allowAttribute(['camera', 'clipboardWrite', 'usb'])).toBe('camera; clipboard-write')
    expect(APP_SANDBOX.split(' ')).not.toContain('allow-same-origin')
    expect(APP_SANDBOX.split(' ')).toContain('allow-scripts')
  })
})
