// Smoke over the REAL stack: a webterm server process (index.ts) on a temp HOME/data dir, and a real
// `webterm mcp` stdio process (main.ts) for a fake node whose header file carries a ledger-issued node
// token. Proves the api.ts mount of `/api/control/mcp/*`, the auth gate for node tokens, and that the
// CLI registry (`/api/tools`) opens to the same token while root-only routes stay shut.
// Token values are never printed.
import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { TOKEN_HEADER } from '../auth'
import { NODE_TOKEN_HEADER } from '../hooksTokens'
import { createPolicyStore } from '../policy/policy.store'
import { MCP_MAIN } from './mcp.launch'

const ENTRY = join(import.meta.dirname, '..', 'index.ts')
const READY_TIMEOUT_MS = 15_000
const dir = mkdtempSync(join(tmpdir(), 'mcp-smoke-'))
const data = join(dir, 'data')
const children: ChildProcess[] = []
afterAll(() => {
  children.forEach((c) => c.kill())
  rmSync(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

const port = await freePort()
// A root token is enforced even on loopback, so the auth gate (not just the route) is what admits the node token.
const rootToken = crypto.randomUUID()
// test-only env: temp HOME (skill stubs land here, never in ~/.claude), Central on so project_list exists.
const server = spawn(process.execPath, ['--no-env-file', ENTRY], {
  cwd: dir, env: { HOME: dir, PATH: process.env.PATH ?? '', WEBTERM_DATA_DIR: data, PORT: String(port), WEBTERM_CENTRAL: 'on', WEBTERM_TOKEN: rootToken }, stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(server)
let log = ''
for (const s of [server.stdout, server.stderr]) s?.on('data', (c: Buffer) => void (log += c.toString()))
const deadline = Date.now() + READY_TIMEOUT_MS
for (;;) {
  if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}): ${log.slice(-2000)}`)
  try { await fetch(`http://127.0.0.1:${port}/healthz-probe`); break } catch { /* not up yet */ }
  if (Date.now() > deadline) throw new Error('server did not come up in time')
  await new Promise((r) => setTimeout(r, 100))
}

// A node token the running server will accept: issued in its own ledger (nodeIdForToken falls back to
// the ledger after a restart; same path a re-adopted session takes).
const ledger = new Database(join(data, 'ledger.db'))
ledger.exec('PRAGMA busy_timeout = 5000')
const token = createPolicyStore(ledger, Date.now).issueToken('node:fake1')
;(ledger as unknown as { close(): void }).close() // the local bun:sqlite shim omits close
const headers = join(dir, 'fake1.headers')
writeFileSync(headers, `${NODE_TOKEN_HEADER}: ${token}\n${TOKEN_HEADER}: ${token}\n`, { mode: 0o600 })

function spawnMcp() {
  const proc = spawn(process.execPath, [MCP_MAIN, '--headers', headers, '--port', String(port)], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '' } })
  children.push(proc)
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  let id = 0
  return async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`)
    const { value, done } = await lines.next()
    if (done) throw new Error('mcp process closed stdout')
    return JSON.parse(value).result as Record<string, unknown>
  }
}

test('webterm mcp lists and calls registry tools through the real HTTP stack with a node token', async () => {
  const rpc = spawnMcp()
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const tools = (await rpc('tools/list')).tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>
  const names = tools.map((t) => t.name)
  expect(names).toEqual(expect.arrayContaining(['project_list', 'browser_act', 'git_diff']))
  expect(Object.keys(tools.find((t) => t.name === 'browser_act')?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['url', 'ref', 'snapId', 'text', 'key']))

  const listed = (await rpc('tools/call', { name: 'project_list', arguments: { limit: 5 } })).structuredContent as { outcome: string; data: { total: number } }
  expect(listed.outcome).toBe('ok')
  expect(listed.data.total).toBe(0)
})

test('the node token opens /api/tools and the MCP backend, not root-only routes', async () => {
  const as = (path: string, h: Record<string, string> = { [TOKEN_HEADER]: token }) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { ...h, accept: 'application/json' } })
  expect((await as('/api/tools')).status).toBe(200)
  expect((await as('/api/tools/whats-new')).status).toBe(200)
  expect((await as('/api/control/mcp/tools')).status).toBe(200)
  expect((await as('/api/tools', {})).status).toBe(403) // no token at all: the gate refuses
  for (const p of ['/api/settings', '/api/workspaces', '/api/outbox?node=fake1']) expect((await as(p)).status).toBe(403)
  expect((await as('/api/settings', { [TOKEN_HEADER]: rootToken })).status).toBe(200) // root still works
})
