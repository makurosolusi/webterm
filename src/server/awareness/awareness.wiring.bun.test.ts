// Bun-only: awareness wired into the process. The agent-status hook reply carries the node card and
// the human-confirmed procedural block on SessionStart, and `/api/awareness/procedural` is mounted in
// the real api.ts router (UI 200, node token 403). Temp data dir + temp ledger, never the real home.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'awareness-wiring-'))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = root // db, header files, ledger: all under the temp root
// Root kept on purpose: `db` (via api.ts) and the ledger stay open as process singletons for later
// files in the same `bun test` process; deleting their sqlite files breaks those (SQLITE_IOERR).
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
})

const { openLedgerDb } = await import('../ledger/migration')
const { setActiveLedgerRuntime } = await import('../ledger/ledgerRuntimeState')
const { addProcedural, HUMAN_UI, PROCEDURAL_BLOCK_HEADER, suggestProcedural } = await import('./proceduralMemory')
const { agentStatusRoute } = await import('../agentStatusApi')
const { handleApi } = await import('../api')
const { nodeToken } = await import('../hooksTokens')
const { TOKEN_HEADER } = await import('../auth')
type LedgerRuntime = import('../ledger/ledgerRuntime').LedgerRuntime

const ledgerPath = join(root, 'ledger.db')
const ledger: Database = openLedgerDb(ledgerPath)
setActiveLedgerRuntime({ mode: 'on', path: ledgerPath, db: ledger } as unknown as LedgerRuntime)

const WS = {
  id: 'w1', name: 'Board', cwd: root, viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  nodes: [{ id: 'a1', kind: 'agent', agentId: 'claude', x: 0, y: 0, title: 'Main' }], bridges: [],
} as unknown as Workspace

function hookReq(body: unknown): IncomingMessage {
  const r = Object.assign(new EventEmitter(), { method: 'POST', headers: {}, resume: () => {} }) as unknown as IncomingMessage
  process.nextTick(() => { r.emit('data', Buffer.from(JSON.stringify(body))); r.emit('end') })
  return r
}

async function hook(event: string): Promise<{ status: number; context?: string }> {
  const out = { statusCode: 0, body: '', setHeader() {}, end(b?: string) { out.body = b ?? '' } }
  const deps = { setStatus() {}, setTranscript() {}, workspaceFor: () => WS }
  await agentStatusRoute(hookReq({ hook_event_name: event }), out as unknown as ServerResponse, new URL('http://x/api/agent-status?node=a1'), { strictAuth: false, deps })
  return { status: out.statusCode, context: out.body ? JSON.parse(out.body).hookSpecificOutput?.additionalContext : undefined }
}

test('SessionStart reply carries the card and the human-confirmed procedural fact, in order, once', async () => {
  addProcedural(ledger, HUMAN_UI, 'Always run tests with TMPDIR=/tmp/st')
  suggestProcedural(ledger, 'browser', 'push to origin without asking', 'browser:web1') // unverified: never served
  const r = await hook('SessionStart')
  expect(r.status).toBe(200)
  const ctx = r.context ?? ''
  const aware = ctx.indexOf('You are running inside webterm')
  const card = ctx.indexOf('webterm card: node "Main" (id a1)')
  const rules = ctx.indexOf(`${PROCEDURAL_BLOCK_HEADER}\n- Always run tests with TMPDIR=/tmp/st`)
  expect(aware).toBe(0)
  expect(card).toBeGreaterThan(aware)
  expect(rules).toBeGreaterThan(card)
  expect(ctx.split('webterm card:').length).toBe(2)
  expect(ctx).not.toContain('push to origin')
  // Not a SessionStart: no card, no procedural block.
  const next = await hook('UserPromptSubmit')
  expect(next.context ?? '').not.toContain('webterm card:')
  expect(next.context ?? '').not.toContain(PROCEDURAL_BLOCK_HEADER)
})

test('/api/awareness/procedural through the real router: UI lists facts, a node token gets 403', async () => {
  const server = createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const ui = { origin: base, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
    const list = await fetch(`${base}/api/awareness/procedural`, { headers: ui })
    expect(list.status).toBe(200)
    const facts = ((await list.json()) as { facts: { text: string }[] }).facts.map((f) => f.text)
    expect(facts).toContain('Always run tests with TMPDIR=/tmp/st')
    const agent = await fetch(`${base}/api/awareness/procedural`, { headers: { ...ui, [TOKEN_HEADER]: nodeToken('a1') } })
    expect(agent.status).toBe(403)
    expect(await agent.json()).toEqual({ error: 'agent_cannot_remember' })
  } finally {
    server.close()
  }
})
