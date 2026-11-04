import { describe, expect, it } from 'vitest'
import { handleLine, handleRpc, LEGACY_VERSIONS, MODERN_VERSION, RPC, type McpBackend } from './mcp.protocol'

const calls: Array<[string, Record<string, unknown>]> = []
const backend: McpBackend = {
  list: async () => [
    { name: 'project_list', description: 'b', inputSchema: { type: 'object' } },
    { name: 'cap_search', description: 'a', inputSchema: { type: 'object' } },
  ],
  call: async (name, args) => {
    calls.push([name, args])
    return name === 'browser_act' ? { outcome: 'denied', detail: 'policy_denied' } : { outcome: 'ok', detail: 'ok', data: { total: 1 } }
  },
}
const modern = { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION } }
const result = (r: unknown) => (r as { result: Record<string, unknown> }).result
const error = (r: unknown) => (r as { error: { code: number; data?: unknown } }).error

describe('webterm mcp protocol (dual-era 2026-07-28)', () => {
  it('serves a legacy initialize, echoing a known version and falling back to the newest legacy one', async () => {
    const r = result(await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, backend))
    expect(r.protocolVersion).toBe('2025-06-18')
    expect(r.capabilities).toEqual({ tools: { listChanged: false } })
    expect((r.serverInfo as { name: string }).name).toBe('webterm')
    const r2 = result(await handleRpc({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, backend))
    expect(r2.protocolVersion).toBe(LEGACY_VERSIONS[0])
  })

  it('implements the mandatory server/discover with versions, ttlMs and cacheScope', async () => {
    const r = result(await handleRpc({ id: 'd', method: 'server/discover', params: modern }, backend))
    expect(r.resultType).toBe('complete')
    expect(r.supportedVersions).toContain(MODERN_VERSION)
    expect(r.capabilities).toEqual({ tools: {} })
    expect(typeof r.ttlMs).toBe('number')
    expect(r.cacheScope).toBe('private')
  })

  it('rejects an unknown per-request version with UnsupportedProtocolVersionError (-32022)', async () => {
    const e = error(await handleRpc({ id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } }, backend))
    expect(e.code).toBe(RPC.unsupportedVersion)
    expect((e.data as { requested: string }).requested).toBe('1900-01-01')
  })

  it('lists tools in deterministic order with cache hints', async () => {
    const r = result(await handleRpc({ id: 4, method: 'tools/list', params: modern }, backend))
    expect((r.tools as { name: string }[]).map((t) => t.name)).toEqual(['cap_search', 'project_list'])
    expect(r.cacheScope).toBe('private')
  })

  it('returns the receipt as structured content and flags non-ok receipts as tool errors', async () => {
    const okRes = result(await handleRpc({ id: 5, method: 'tools/call', params: { name: 'project_list', arguments: { limit: 5 } } }, backend))
    expect(okRes.isError).toBe(false)
    expect(okRes.structuredContent).toEqual({ outcome: 'ok', detail: 'ok', data: { total: 1 } })
    expect(JSON.parse((okRes.content as { text: string }[])[0].text).outcome).toBe('ok')
    expect(calls.at(-1)).toEqual(['project_list', { limit: 5 }])
    const denied = result(await handleRpc({ id: 6, method: 'tools/call', params: { name: 'browser_act' } }, backend))
    expect(denied.isError).toBe(true)
  })

  it('answers nothing to notifications, -32601 to unknown methods, -32700 to garbage', async () => {
    expect(await handleRpc({ method: 'notifications/initialized' }, backend)).toBeNull()
    expect(error(await handleRpc({ id: 7, method: 'sampling/createMessage' }, backend)).code).toBe(RPC.methodNotFound)
    expect(error(await handleLine('{nope', backend)).code).toBe(RPC.parse)
    expect(await handleLine('   ', backend)).toBeNull()
  })

  it('turns a backend failure into a -32603 error naming the operation', async () => {
    const broken: McpBackend = { list: async () => { throw new Error('connect ECONNREFUSED') }, call: async () => ({}) }
    const e = error(await handleLine(JSON.stringify({ id: 8, method: 'tools/list' }), broken))
    expect(e.code).toBe(RPC.internal)
  })
})
