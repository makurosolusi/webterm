// Policy lock: a screenshot's base64 reaches the model as ONE MCP image block and is stored nowhere in
// webterm. Walks the real hops: control route (mcp.call event) -> Central exec (audit, receipt) ->
// stdio projection (handleRpc) -> the Claude stream parser that feeds the chat store. Then scans every
// row of every ledger table for the base64.
import { expect, test } from 'bun:test'
import { createControlGuard } from '../../guard/controlGuard'
import { freshDb, rows } from '../../guard/controlGuard.testutil'
import { parseClaudeMessage } from '../../runtime/claudeEvents'
import { createRegistry } from '../toolRegistry'
import { createEventLog } from '../../../events/eventLog'
import { handleRpc } from '../../../mcp/mcp.protocol'
import { CENTRAL_MCP_MINTER } from '../../../mcp/mcp.paths'
import { mcpRoute } from '../../../mcp/mcp.route'
import type { McpDeps } from '../../../mcp/mcp.tools'
import { createCanvasShotDefsWith } from './canvas.shot.def'
import { READ_TOOLS_FLAG } from './read.shared'

const B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 9)]).toString('base64') // test-only
const TOKEN = 'test-only-capability'

test('the screenshot base64 is in the MCP image block and in no stored row, event or chat text', async () => {
  const db = freshDb()
  const registry = createRegistry()
  createCanvasShotDefsWith({ shoot: async () => ({ ok: true, mimeType: 'image/jpeg', data: B64 }) }).forEach((d) => registry.register(d))
  const deps: McpDeps = {
    policy: null, workspaces: () => [], browser: null, gitDiff: async () => null, events: createEventLog(db),
    central: { db, registry, env: { [READ_TOOLS_FLAG]: 'on' }, guard: createControlGuard({ db, now: Date.now, env: {} }) },
    capability: (t) => (t === TOKEN ? { mintedBy: `${CENTRAL_MCP_MINTER}central:global` } : undefined),
  }
  const http = await mcpRoute({ method: 'POST', path: '/api/control/mcp/call', headers: { 'x-webterm-capability': TOKEN }, body: { name: 'canvas_screenshot', arguments: {} } }, deps)
  expect(http?.status).toBe(200)
  const body = http!.body as Record<string, unknown>
  expect(body).toMatchObject({ outcome: 'ok', data: { mimeType: 'image/jpeg', image: { data: B64 } } })

  const rpc = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'canvas_screenshot', arguments: {} } },
    { list: async () => [], call: async () => body })
  const result = (rpc as { result: { content: Array<Record<string, unknown>>; structuredContent: unknown } }).result
  expect(result.content.filter((b) => b.type === 'image')).toEqual([{ type: 'image', data: B64, mimeType: 'image/jpeg' }])
  expect(JSON.stringify(result.content.filter((b) => b.type !== 'image'))).not.toContain(B64)
  expect(JSON.stringify(result.structuredContent)).not.toContain(B64)

  // What Claude Code echoes back as the tool_result is what the chat store keeps (tool.completed output).
  const echoed = parseClaudeMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: result.content }] } })
  expect(echoed).toMatchObject({ type: 'tool_results', results: [{ toolUseId: 'tu1', isError: false }] })
  expect(JSON.stringify(echoed)).not.toContain(B64)

  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name))
  expect(tables).toContain('event')
  expect(rows(db, "SELECT count(*) AS c FROM event WHERE kind IN ('mcp.call', 'central.proposal')")[0]?.c).toBe(2)
  for (const t of tables) expect({ t, hit: JSON.stringify(rows(db, `SELECT * FROM "${t}"`)).includes(B64) }).toEqual({ t, hit: false })
})
