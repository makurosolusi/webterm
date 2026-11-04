// Bun-only e2e: a real `webterm mcp` stdio process (main.ts) against an in-process backend running the
// real policy engine on the real ledger schema, authenticated by the node's header file.
import { afterAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mcp-e2e-'))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = root // header files land here, never in ~/.webterm-server
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  rmSync(root, { recursive: true, force: true })
})

import type { Workspace, WsNode } from '../../shared/workspace'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { CAP_DEFS } from '../central/tools/defs/cap.defs'
import { PROJECT_READ_DEFS } from '../central/tools/defs/read.project'
import { READ_TOOLS_FLAG } from '../central/tools/defs/read.shared'
import { createRegistry } from '../central/tools/toolRegistry'
import { toolInputSchema } from '../central/tools/toolCapability'
import type { ControlRequest } from '../control/controlTypes'
import { createEventLog } from '../events/eventLog'
import { claudeHeadersPath } from '../hooksPaths'
import { writeNodeHeaders } from '../hooksSettings'
import { nodeToken } from '../hooksTokens'
import { createPolicy } from '../policy/policy.decide'
import { MCP_MAIN } from './mcp.launch'
import { mcpRoute } from './mcp.route'
import type { McpDeps } from './mcp.tools'

const node = (id: string, kind: WsNode['kind'], cwd?: string): WsNode => ({ id, kind, x: 0, y: 0, ...(cwd ? { cwd } : {}) })
const BOARD: Workspace[] = [{
  id: 'w1', name: 'w', cwd: root, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  nodes: [node('a1', 'agent'), node('a2', 'agent'), node('b1', 'browser')],
  bridges: [{ id: 'e1', source: 'a2', target: 'b1', kind: 'context' }],
}]

const db = freshDb()
const registry = createRegistry()
for (const def of [...CAP_DEFS, ...PROJECT_READ_DEFS]) registry.register(def)
const browserCalls: ControlRequest[] = []
const deps: McpDeps = {
  policy: createPolicy({ db, workspaces: () => BOARD }),
  workspaces: () => BOARD,
  central: { db, registry, env: { [READ_TOOLS_FLAG]: 'on' } },
  browser: async (req) => { browserCalls.push(req); return { status: 200, body: { ok: true, data: { url: 'https://example.com/' } } } },
  gitDiff: async () => ({ status: 200, body: { files: [], total: 0 } }),
  events: createEventLog(db),
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    const r = await mcpRoute({ method, path: url.pathname, headers: req.headers, ...(method === 'POST' ? { body: JSON.parse(raw) } : {}) }, deps)
    res.writeHead(r?.status ?? 404, { 'content-type': 'application/json' }).end(JSON.stringify(r?.body ?? { error: 'not_found' }))
  })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as AddressInfo).port
afterAll(() => { server.close() })

/** Spawns main.ts for `nodeId` and returns a request() that writes one JSON-RPC line and awaits its answer. */
function spawnMcp(nodeId: string) {
  const headers = writeNodeHeaders(nodeId)
  const argv = [process.execPath, MCP_MAIN, '--headers', headers, '--port', String(port)]
  const proc = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '' } })
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  const next = async (): Promise<Record<string, unknown>> => {
    const { value, done } = await lines.next()
    if (done) throw new Error('mcp process closed stdout')
    return JSON.parse(value)
  }
  let id = 0
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`)
    return next()
  }
  const notify = async (method: string) => { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) }
  return { argv, proc, request, notify }
}
const resultOf = (r: Record<string, unknown>) => r.result as Record<string, unknown>
const receiptOf = (r: Record<string, unknown>) => resultOf(r).structuredContent as Record<string, unknown>

test('initialize -> tools/list -> tools/call over a real stdio process, authenticated by the header file', async () => {
  const mcp = spawnMcp('a1')
  try {
    const init = resultOf(await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } }))
    expect(init.protocolVersion).toBe('2025-11-25')
    await mcp.notify('notifications/initialized')
    const discover = resultOf(await mcp.request('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }))
    expect(discover.supportedVersions).toContain('2026-07-28')

    const tools = resultOf(await mcp.request('tools/list')).tools as Array<{ name: string; inputSchema: unknown }>
    const names = tools.map((t) => t.name)
    for (const n of ['project_list', 'project_read', 'cap_search', 'cap_describe', 'browser_read', 'browser_act', 'git_diff']) expect(names).toContain(n)
    expect(names).toEqual([...names].sort())
    // Schemas are the registry's own (Central defs: toolInputSchema, incl. projectId when project-scoped).
    expect(tools.find((t) => t.name === 'project_read')?.inputSchema).toEqual(toolInputSchema(PROJECT_READ_DEFS[0]))
    expect(names.some((n) => n.startsWith('node_') || n.startsWith('approval_'))).toBe(false)

    const listed = receiptOf(await mcp.request('tools/call', { name: 'project_list', arguments: { limit: 10 } }))
    expect(listed.outcome).toBe('ok')
    expect((listed.data as { total: number }).total).toBe(2)
    expect(typeof (listed.evidence as { mcpSeq: number }).mcpSeq).toBe('number')

    const bad = receiptOf(await mcp.request('tools/call', { name: 'project_list', arguments: { limit: 'x' } }))
    expect(bad.detail).toBe('invalid_shape')
  } finally {
    mcp.proc.kill()
  }
})

test('a node without a cable to a browser is denied browser.act by policy; a wired node is not', async () => {
  const lone = spawnMcp('a1')
  const wired = spawnMcp('a2')
  try {
    const denied = await lone.request('tools/call', { name: 'browser_act', arguments: { verb: 'navigate', url: 'https://example.com/' } })
    expect(resultOf(denied).isError).toBe(true)
    expect(receiptOf(denied)).toMatchObject({ outcome: 'denied', detail: 'policy_denied' })
    expect(browserCalls).toHaveLength(0)

    const allowed = receiptOf(await wired.request('tools/call', { name: 'browser_act', arguments: { verb: 'navigate', url: 'https://example.com/' } }))
    expect(allowed.outcome).toBe('ok')
    expect(browserCalls).toHaveLength(1)
    expect(browserCalls[0].path).toBe('/api/control/browser/navigate')
    expect(browserCalls[0].body).toEqual({ url: 'https://example.com/' })

    // Every call is decided and audited.
    const decisions = rows(db, "SELECT actor, payload_json FROM event WHERE kind = 'policy.decision' AND actor = 'node:a1'")
      .map((r) => JSON.parse(String(r.payload_json)) as { capability: string; effect: string })
    expect(decisions.some((d) => d.capability === 'browser.act' && d.effect === 'deny')).toBe(true)
    const audited = rows(db, "SELECT actor, payload_json FROM event WHERE kind = 'mcp.call'").map((r) => ({ actor: r.actor, ...JSON.parse(String(r.payload_json)) }))
    const has = (want: Record<string, unknown>) => audited.some((a) => Object.entries(want).every(([k, v]) => (a as Record<string, unknown>)[k] === v))
    expect(has({ actor: 'node:a1', tool: 'browser.act', outcome: 'denied', detail: 'policy_denied' })).toBe(true)
    expect(has({ actor: 'node:a2', tool: 'browser.act', outcome: 'ok', detail: 'ok' })).toBe(true)
  } finally {
    lone.proc.kill()
    wired.proc.kill()
  }
})

test('git.diff stays inside the node folder; the token never reaches argv or env', async () => {
  const mcp = spawnMcp('a1')
  try {
    expect(receiptOf(await mcp.request('tools/call', { name: 'git_diff', arguments: { root: '/' } })).detail).toBe('outside_cwd')
    expect(receiptOf(await mcp.request('tools/call', { name: 'git_diff', arguments: { root } })).outcome).toBe('ok')
    const token = nodeToken('a1')
    expect(readFileSync(claudeHeadersPath('a1'), 'utf8')).toContain(token)
    expect(mcp.argv.join(' ')).not.toContain(token)
    expect(Object.values(process.env).some((v) => v === token)).toBe(false)
  } finally {
    mcp.proc.kill()
  }
})

test('the backend refuses a request without a node token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/control/mcp/tools`)
  expect(res.status).toBe(401)
})
