// Bun-only e2e for Central via MCP (PLAN F2-c): a real TurnService + ClaudeRuntime whose `claude` is a
// fake that reads `--mcp-config`, starts the real `webterm mcp` stdio server (main.ts) from it and
// issues MCP tool calls, against an in-process backend (mcpRoute) with the real guard, ledger approvals
// and the process capability store. Checks: receipts land in the chat, an R2 call opens one approval
// card, approve runs it exactly once, reject never runs it.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mcp-central-'))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = root // anything lazily resolving dataDir() lands here, never in ~/.webterm-server
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  rmSync(root, { recursive: true, force: true })
})

import { obj, S } from '../capability/capability.schema'
import { StreamHub } from '../central/chat/streamHub'
import { TurnService } from '../central/chat/turnService'
import { getOrCreateConversation, listConversationEvents } from '../central/conversationStore'
import { createControlGuard } from '../central/guard/controlGuard'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { ClaudeRuntime } from '../central/runtime/claudeRuntime'
import { writeFakeClaude } from '../central/runtime/claude.fakeBin'
import { createCentralMcpLink, processMint } from '../central/runtime/claudeMcp'
import { createRegistry } from '../central/tools/toolRegistry'
import type { ToolDef } from '../central/tools/toolTypes'
import { allows } from '../control/capabilities'
import { capabilityStore } from '../control/mount'
import { createEventLog } from '../events/eventLog'
import { decideApproval } from '../ledger/ledgerApproval'
import { MCP_MAIN } from './mcp.launch'
import { mcpRoute } from './mcp.route'
import type { McpDeps } from './mcp.tools'

const db = freshDb()
getOrCreateConversation(db, 'global', Date.now())
let deploys: string[] = []
beforeEach(() => { deploys = [] })

// test-only tools: one R0 read, one R2 effect whose handler counts real executions.
const peek: ToolDef = {
  name: 'test.peek', summary: 'test-only read', tier: 'R0', projectScoped: false, usage: '{}',
  input: obj({}), output: S.anyObj('answer'), validate: () => null, handler: () => ({ ok: true, data: { answer: 42 } }),
}
const deploy: ToolDef = {
  name: 'test.deploy', summary: 'test-only R2 effect', tier: 'R2', usage: '{"projectId":"<id>","target":"<name>"}',
  input: obj({ target: S.str(40) }, ['target']), output: S.anyObj('deployed target'), validate: () => null,
  handler: (_ctx, input) => { deploys.push(String(input.target)); return { ok: true, data: { deployed: input.target } } },
}
const registry = createRegistry()
registry.register(peek)
registry.register(deploy)
// The Worker card ceiling (`propose`) lifts the level to act_gated: R2 runs, but only after a card.
const guard = createControlGuard({ db, now: Date.now, env: { WEBTERM_CENTRAL_AGENTS: 'propose' } })
const deps: McpDeps = {
  policy: null, workspaces: () => [], browser: null, gitDiff: async () => null, events: createEventLog(db),
  central: { db, registry, env: {}, guard },
  capability: (t) => capabilityStore.verify(t),
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

const script = join(root, 'calls.json')
/** Fake `claude`: starts the MCP server named in --mcp-config, then calls each scripted tool over stdio. */
const FAKE = writeFakeClaude(root, `const { spawn } = await import('node:child_process')
const a = process.argv.slice(2)
const cfg = JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.webterm
const srv = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiting = new Map()
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (c) => { buf += c; for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m) } })
let next = 0
const rpc = (method, params) => new Promise((r) => { const id = ++next; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n') })
readStdin()
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } })
const list = await rpc('tools/list', {})
emit({ type: 'system', subtype: 'init', session_id: 'sess-mcp', tools: list.result.tools.map((t) => 'mcp__webterm__' + t.name), mcp_servers: [{ name: 'webterm', status: 'connected' }] })
let n = 0
for (const c of JSON.parse(fs.readFileSync(${JSON.stringify(script)}, 'utf8'))) {
  const tu = 'tu' + (++n)
  emit({ type: 'assistant', message: { id: 'm' + n, content: [{ type: 'tool_use', id: tu, name: 'mcp__webterm__' + c.name, input: c.args }], usage: { input_tokens: 1, output_tokens: 1 } } })
  const r = await rpc('tools/call', { name: c.name, arguments: c.args })
  emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: r.result.content[0].text, ...(r.result.isError ? { is_error: true } : {}) }] } })
}
emit({ type: 'assistant', message: { id: 'mz', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } })
emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-mcp', total_cost_usd: 0, duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } })
srv.stdin.end()
`)

function service(approvalWaitMs: number): TurnService {
  const mcp = createCentralMcpLink({ dir: join(root, 'mcp'), port, approvalWaitMs, command: { command: process.execPath, args: [MCP_MAIN] } })
  const runtime = new ClaudeRuntime({ executable: FAKE, workDir: join(root, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, killGraceMs: 50, mcp })
  return new TurnService({ db, runtime, stream: new StreamHub({ heartbeatMs: 0 }), env: {} })
}

let msg = 0
async function turn(svc: TurnService, calls: Array<{ name: string; args: Record<string, unknown> }>) {
  writeFileSync(script, JSON.stringify(calls))
  const after = rows(db, 'SELECT max(seq) AS s FROM central_event')[0]?.s as number | null ?? 0
  const submitted = svc.submit({ conversationId: 'central:global', clientMessageId: `m-${++msg}`, text: 'go' })
  const done = await submitted.done
  const events = listConversationEvents(db, 'central:global', after, 500)
  return { done, events, tools: events.filter((e) => e.type === 'tool.completed').map((e) => e.payload as Record<string, unknown>) }
}

const cards = (prefix = 'ct-') => rows(db, `SELECT a.id, a.status, a.kind, d.action_digest AS digest, d.nonce, d.single_use FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id LIKE ? ORDER BY a.created_at, a.rowid`, `${prefix}%`)

async function decideWhenCardAppears(approve: boolean, known: number): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const all = cards()
    const card = all[known]
    if (card) {
      decideApproval({ db, now: Date.now }, String(card.id), { approve, actor: 'human:alice', digest: String(card.digest), nonce: String(card.nonce) })
      return String(card.id)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('no approval card appeared')
}

test('the per-turn capability token proves Central only: it opens nothing in the control API and dies with the turn', async () => {
  const minted = await processMint('central:global', 60_000)
  const record = capabilityStore.verify(minted.token)
  expect(record?.mintedBy).toBe('central-mcp:central:global')
  expect(allows(record!, 'node.read', 'workspace:w1')).toBe(false)
  expect(allows(record!, 'node.read', 'node:n1')).toBe(false)
  minted.revoke()
  expect(capabilityStore.verify(minted.token)).toBe(undefined)
  const listed = await mcpRoute({ method: 'GET', path: '/api/control/mcp/tools', headers: { 'x-webterm-capability': minted.token } }, deps)
  expect(listed?.status).toBe(401)
})

test('a Central turn calls an R0 tool natively over MCP and the receipt streams into the chat', async () => {
  const { done, events, tools } = await turn(service(0), [{ name: 'test_peek', args: {} }, { name: 'nope_tool', args: {} }])
  expect(done.status).toBe('succeeded')
  expect(events.find((e) => e.type === 'tool.requested')?.payload).toMatchObject({ name: 'test_peek', toolCallId: 'tu1' })
  expect(tools[0]).toMatchObject({ name: 'test_peek', ok: true, output: { outcome: 'ok', data: { answer: 42 } } })
  expect(tools[1]).toMatchObject({ name: 'nope_tool', ok: false, errorCode: 'unknown_tool' })
  expect(rows(db, "SELECT count(*) AS c FROM event WHERE kind = 'mcp.call' AND actor = 'central'")[0]?.c).toBeGreaterThan(1)
})

test('R2: one approval card; approve runs the call exactly once inside the turn; a repeat asks again', async () => {
  const svc = service(10_000)
  const call = { name: 'test_deploy', args: { projectId: 'p1', target: 'prod' } }
  const decided = decideWhenCardAppears(true, cards().length)
  const first = await turn(svc, [call])
  const id = await decided
  expect(first.done.status).toBe('succeeded')
  expect(first.tools[0]).toMatchObject({ name: 'test_deploy', ok: true, output: { data: { deployed: 'prod' }, evidence: { approvalId: id } } })
  expect(deploys).toEqual(['prod'])
  expect(cards().find((c) => c.id === id)).toMatchObject({ kind: 'test.deploy', status: 'approved', single_use: 0 })

  // Same call again: the spent card cannot run it twice. The guard has now seen this exact effect three
  // times in its window, so the doom-loop breaker refuses it before any new card.
  const again = await turn(service(0), [call])
  expect(again.tools[0]).toMatchObject({ ok: false, errorCode: 'doom_loop' })
  expect(deploys).toEqual(['prod'])
})

test('R2 left undecided: the receipt says pending, the chat message carries the approval note, nothing runs', async () => {
  const { tools } = await turn(service(0), [{ name: 'test_deploy', args: { projectId: 'p1', target: 'canary' } }])
  expect(tools[0]).toMatchObject({ ok: false, errorCode: 'approval_required', output: { data: { status: 'pending' } } })
  const approvalId = (tools[0].output as { data: { approvalId: string } }).data.approvalId
  expect(cards().find((c) => c.id === approvalId)).toMatchObject({ status: 'pending', kind: 'test.deploy' })
  const parts = rows(db, "SELECT parts_json FROM central_message WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1")[0]?.parts_json
  expect(JSON.parse(String(parts))).toEqual(expect.arrayContaining([{ type: 'approval', approvalId, state: 'awaiting_approval' }]))
  expect(deploys).toEqual([])
})

test('R2 rejected: the handler never runs, and a retry of the rejected call is refused without a new card', async () => {
  const call = { name: 'test_deploy', args: { projectId: 'p1', target: 'staging' } }
  const before = cards().length
  const decided = decideWhenCardAppears(false, before)
  const first = await turn(service(10_000), [call])
  await decided
  expect(first.tools[0]).toMatchObject({ ok: false, errorCode: 'approval_rejected' })
  const retry = await turn(service(0), [call])
  expect(retry.tools[0]).toMatchObject({ ok: false, errorCode: 'approval_rejected' })
  expect(cards().length).toBe(before + 1)
  expect(deploys).toEqual([])
})

test('without the CA2 guard Central sees no tools and every call is refused (fail closed)', async () => {
  const minted = await processMint('central:global', 60_000)
  try {
    const off: McpDeps = { ...deps, central: { db, registry, env: {} } }
    const headers = { 'x-webterm-capability': minted.token }
    expect((await mcpRoute({ method: 'GET', path: '/api/control/mcp/tools', headers }, off))?.body).toEqual({ tools: [] })
    const called = await mcpRoute({ method: 'POST', path: '/api/control/mcp/call', headers, body: { name: 'test_peek', arguments: {} } }, off)
    expect(called?.body).toMatchObject({ outcome: 'error', detail: 'central_off' })
  } finally {
    minted.revoke()
  }
})
