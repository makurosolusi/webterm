// Golden harness (RND/29-b §4.13, K7): a real file-backed ledger + TurnService + ClaudeRuntime whose
// `claude` is a fake that starts the real `webterm mcp` stdio server (mcp/main.ts) from `--mcp-config`
// and issues scripted MCP tool calls against an in-process mcpRoute backend with the real CA2 control
// guard. Copied from mcp.central.bun.test.ts. `restart()` reopens the database file the way a process
// reboot would; a `hang` step leaves the turn running so a crash can be simulated. Bun-only (bun:sqlite).
//
// TODO(ca2-16b): golden tests still to write once their workstreams land (RND/29-b §4.13):
//   G1  happy path chat -> proposal -> approval -> worker -> verified (needs WS-09/10 + WS-19 wiring)
//   G4  crash during spawn leaves no orphan worker/task (needs WS-09 agent.* state machine)
//   G5  long conversation keeps context within budget (needs WS-06 assembler + WS-08 memory)
//   G6  >=20 injection payloads, canary secret = 0 (extend adversarialPayloads.ts; needs WS-05/07)
//   G8  provider breaker opens on 429/auth/quota and backs off (needs WS-07 breaker)
//   G9  POST /api/central/halt stops all effects (needs WS-07 kill-switch + WS-19 route)
//   G10 memory survives a model/runtime swap (needs WS-08)
//   G11 invalid/group approval is refused (needs WS-12 channel + approval gate wiring)
//   G12 audit hash chain verifies and detects tampering (needs ledger v9, WS-18)
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { capabilityStore } from '../../control/mount'
import { createEventLog } from '../../events/eventLog'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { openLedgerDb } from '../../ledger/migration'
import { MCP_MAIN } from '../../mcp/mcp.launch'
import { mcpRoute } from '../../mcp/mcp.route'
import type { McpDeps } from '../../mcp/mcp.tools'
import { StreamHub } from '../chat/streamHub'
import { reconcileTurns, type ReconcileResult } from '../chat/turnReconciler'
import { TurnService } from '../chat/turnService'
import { listConversationEvents } from '../conversationStore'
import { createControlGuard } from '../guard/controlGuard'
import { utcDay } from '../guard/budgetStore'
import { writeFakeClaude } from '../runtime/claude.fakeBin'
import { createCentralMcpLink } from '../runtime/claudeMcp'
import { ClaudeRuntime } from '../runtime/claudeRuntime'
import { CORE_DEFS } from '../tools/defs/core.defs'
import { createRegistry } from '../tools/toolRegistry'
import type { ToolDef } from '../tools/toolTypes'

export const GOLDEN_PROJECT = 'p1' // test-only
export const GOLDEN_CONVERSATION = 'central:global'
/** The Worker card ceiling: R1 runs, R2 asks for a card (same level the MCP e2e uses). */
const GUARD_ENV = { WEBTERM_CENTRAL_AGENTS: 'propose' } // test-only
const HUNG_POLL_MS = 20

/** One scripted step of the fake model. `call` takes the MCP name (`goal_propose`), as Claude sees it. */
export type FakeStep =
  | { text: string; tokens?: number }
  | { call: string; args: Record<string, unknown> }
  | { pause: number }
  | { hang: true }

export interface HarnessOptions {
  /** One list of steps per runtime turn, consumed in order. */
  turns: readonly FakeStep[][]
  /** Per-turn limit env (e.g. `WEBTERM_CENTRAL_TURN_STEPS`); defaults to none. */
  limitEnv?: NodeJS.ProcessEnv
  /** Runtime-side token cap per turn (ClaudeRuntime `maxTokens`). */
  maxTokens?: number
  /** Extra test-only tools next to the core ones. */
  tools?: readonly ToolDef[]
}

export interface ToolReceipt { name: string; ok: boolean; errorCode?: string; output?: Record<string, unknown> }

export interface GoldenHarness {
  db: Database
  service: TurnService
  /** Runtime turns started since the last (re)boot; replay must never start one. */
  readonly calls: number
  /** Resolves once a `hang` step is reached AND the server has persisted the text streamed before it. */
  hung(): Promise<void>
  /** Simulates a crash + reboot: drops the process state, reopens the DB file, reconciles. */
  restart(turns: readonly FakeStep[][]): ReconcileResult
  /** `tool.completed` payloads streamed into the chat, oldest first. */
  receipts(): ToolReceipt[]
  count(sql: string, ...params: unknown[]): number
  /** Tables with `needle` in any column of any row (secret-canary scan); [] when it is nowhere. */
  tablesWith(needle: string): string[]
  cleanup(): Promise<void>
}

/** Sets today's global budget row (the real guard reads it), replacing any previous one. */
export function setDailyUsage(db: Database, usage: { tokens: number; spawns: number }): void {
  execWrite(db, `INSERT OR REPLACE INTO central_budget (day, scope, tokens, spawns) VALUES (?, 'global', ?, ?)`, utcDay(Date.now()), usage.tokens, usage.spawns)
}

/** Fake `claude`: picks its turn by a counter file, then plays the steps over the real MCP stdio server. */
function fakeSource(turnsFile: string, counterFile: string, hungFile: string): string {
  return `const { spawn } = await import('node:child_process')
const a = process.argv.slice(2)
const n = Number(fs.existsSync(${JSON.stringify(counterFile)}) ? fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8') : '0')
fs.writeFileSync(${JSON.stringify(counterFile)}, String(n + 1))
const steps = JSON.parse(fs.readFileSync(${JSON.stringify(turnsFile)}, 'utf8'))[n]
readStdin()
if (!steps) { emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-golden' }); process.exit(1) }
const cfg = JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.webterm
const srv = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiting = new Map()
srv.stdout.setEncoding('utf8')
srv.stdout.on('data', (c) => { buf += c; for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m) } })
let next = 0
const rpc = (method, params) => new Promise((r) => { const id = ++next; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n') })
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } })
const list = await rpc('tools/list', {})
emit({ type: 'system', subtype: 'init', session_id: 'sess-golden', tools: list.result.tools.map((t) => 'mcp__webterm__' + t.name), mcp_servers: [{ name: 'webterm', status: 'connected' }] })
let m = 0
for (const s of steps) {
  if ('text' in s) {
    const t = s.tokens ?? 1
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s.text } } })
    emit({ type: 'assistant', message: { id: 'm' + (++m), content: [{ type: 'text', text: s.text }], usage: { input_tokens: t, output_tokens: t } } })
  } else if ('pause' in s) {
    await new Promise((r) => setTimeout(r, s.pause))
  } else if ('hang' in s) {
    fs.writeFileSync(${JSON.stringify(hungFile)}, String(process.pid))
    await new Promise(() => setInterval(() => {}, 60000))
  } else {
    const tu = 'tu' + (++m)
    emit({ type: 'assistant', message: { id: 'm' + m, content: [{ type: 'tool_use', id: tu, name: 'mcp__webterm__' + s.call, input: s.args }], usage: { input_tokens: 1, output_tokens: 1 } } })
    const r = await rpc('tools/call', { name: s.call, arguments: s.args })
    emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: r.result.content[0].text, ...(r.result.isError ? { is_error: true } : {}) }] } })
  }
}
emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-golden', total_cost_usd: 0, duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } })
srv.stdin.end()
`
}

/** Text the server has persisted for the running turn (same source the reconciler rebuilds partialText from). */
function streamedRunningText(db: Database): string {
  return allRows(db, `SELECT e.payload_json FROM central_event e JOIN central_turn t ON t.id = e.turn_id
    WHERE t.status = 'running' AND e.type = 'part.delta' ORDER BY e.seq ASC`)
    .map((row) => String((JSON.parse(String(row['payload_json'])) as { delta?: unknown }).delta ?? '')).join('')
}

function closeDb(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}

/** Builds a harness; the caller must `await cleanup()` (stops the backend, kills a hung fake, removes the temp dir). */
export async function createHarness(options: HarnessOptions): Promise<GoldenHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-golden-'))
  const prevDataDir = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = dir // anything lazily resolving dataDir() lands here, never in ~/.webterm-server
  const dbPath = join(dir, 'ledger.db')
  const turnsFile = join(dir, 'turns.json')
  const counterFile = join(dir, 'calls')
  const hungFile = join(dir, 'hung.pid')
  const registry = createRegistry()
  for (const def of [...CORE_DEFS, ...(options.tools ?? [])]) registry.register(def)
  const fake = writeFakeClaude(dir, fakeSource(turnsFile, counterFile, hungFile))

  let deps: McpDeps
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

  function boot(turns: readonly FakeStep[][]): { db: Database; service: TurnService; runtime: ClaudeRuntime } {
    writeFileSync(turnsFile, JSON.stringify(turns))
    rmSync(counterFile, { force: true })
    const db = openLedgerDb(dbPath)
    const guard = createControlGuard({ db, now: Date.now, env: GUARD_ENV })
    deps = {
      policy: null, workspaces: () => [], browser: null, gitDiff: async () => null, events: createEventLog(db),
      central: { db, registry, env: GUARD_ENV, guard }, capability: (t) => capabilityStore.verify(t),
    }
    const mcp = createCentralMcpLink({ dir: join(dir, 'mcp'), port, approvalWaitMs: 0, command: { command: process.execPath, args: [MCP_MAIN] } })
    const runtime = new ClaudeRuntime({
      executable: fake, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, mcp,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    })
    const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
    const service = new TurnService({ db, runtime, stream, env: options.limitEnv ?? {} })
    return { db, service, runtime }
  }

  /** Kills a fake parked on `hang`; its MCP child exits with the closed pipe. */
  function killHung(): void {
    if (!existsSync(hungFile)) return
    try {
      process.kill(Number(readFileSync(hungFile, 'utf8')), 'SIGKILL')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
    rmSync(hungFile, { force: true })
  }

  let script = options.turns
  let current = boot(script)
  const now = Date.now()
  execWrite(
    current.db,
    `INSERT OR IGNORE INTO project (id, workspace_id, name, path, status, priority, created_at, updated_at)
     VALUES (?, 'w-p1', 'Alpha', '/tmp/p1', 'active', 5, ?, ?)`,
    GOLDEN_PROJECT, now, now
  )

  const harness: GoldenHarness = {
    get db() { return current.db },
    get service() { return current.service },
    get calls() { return existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0 },
    async hung() {
      while (!existsSync(hungFile)) await new Promise((r) => setTimeout(r, HUNG_POLL_MS))
      // hung.pid is a side channel: it can land before this process has read the fake's stdout (an
      // event-loop stall in the one-process suite). Restarting then closes the DB under unread deltas:
      // partialText comes back null and the late deltas throw "Database has closed" in the next test.
      // So "hung" also means: every text step before the hang is persisted as a part.delta.
      const steps = script[harness.calls - 1] ?? []
      const hang = steps.findIndex((s) => 'hang' in s)
      const expected = steps.slice(0, hang).map((s) => ('text' in s ? s.text : '')).join('')
      while (streamedRunningText(current.db) !== expected) await new Promise((r) => setTimeout(r, HUNG_POLL_MS))
    },
    restart(turns) {
      // Close first: the crashed process must not get to finalize its turn; the reconciler does that.
      closeDb(current.db)
      killHung()
      script = turns
      current = boot(turns)
      return reconcileTurns(current.db, Date.now())
    },
    receipts: () => allRows(current.db, `SELECT payload_json FROM central_event WHERE type = 'tool.completed' ORDER BY seq ASC`)
      .map((row) => JSON.parse(String(row['payload_json'])) as ToolReceipt),
    count: (sql, ...params) => Number(getRow(current.db, sql, ...params)?.['c'] ?? -1),
    tablesWith(needle) {
      return allRows(current.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .map((table) => String(table['name']))
        .filter((name) => allRows(current.db, `SELECT * FROM "${name}"`).some((row) => JSON.stringify(row).includes(needle)))
    },
    async cleanup() {
      killHung()
      await current.runtime.close()
      closeDb(current.db)
      await new Promise<void>((done) => server.close(() => done()))
      if (prevDataDir === undefined) delete process.env.WEBTERM_DATA_DIR
      else process.env.WEBTERM_DATA_DIR = prevDataDir
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}
