// data-209-1 lock: the Senses `event` table is append-only, so `POST /api/agent-status` must not
// turn stray local POSTs into permanent rows. Runs the real route over HTTP against a real ledger.
import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wt-ghost-'))
process.env.WEBTERM_DATA_DIR = dir // before ./db opens
delete process.env.WEBTERM_STRICT_HOOK_AUTH // the zero-config default
const { agentStatusRoute } = await import('./agentStatusApi')
const { startLedgerRuntime } = await import('./ledger/ledgerRuntime')
const { resetActiveLedgerRuntimeForTest } = await import('./ledger/ledgerRuntimeState')
const { resetEventsRuntimeForTest } = await import('./events/eventsRuntime')
const { db } = await import('./db')
const { nodeToken, NODE_TOKEN_HEADER } = await import('./hooks')

const GHOST_POSTS = 300
const runtime = startLedgerRuntime({ mode: 'on', path: join(dir, 'ledger.db') })!
const events = (): number => Number((runtime.db.query('SELECT COUNT(*) AS c FROM event').get() as { c: number }).c)

let strictAuth: boolean | undefined
const server = http.createServer((req, res) => {
  void agentStatusRoute(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), strictAuth === undefined ? undefined : { strictAuth })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => {
  server.close()
  resetEventsRuntimeForTest()
  resetActiveLedgerRuntimeForTest()
  rmSync(dir, { recursive: true, force: true })
})

async function post(node: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-status?node=${node}`, {
    method: 'POST', headers, body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
  })
  await res.arrayBuffer()
  return res.status
}

test(`${GHOST_POSTS} tokenless POSTs for fake nodes add 0 ledger rows (default strict)`, async () => {
  const before = events()
  const statuses = new Set<number>()
  for (let i = 0; i < GHOST_POSTS; i++) statuses.add(await post(`ghost${i}`))
  expect(events() - before).toBe(0)
  expect([...statuses]).toEqual([403])
}, 60_000)

test('a node on no board adds 0 rows even with strict auth turned off', async () => {
  strictAuth = false
  try {
    const before = events()
    for (let i = 0; i < 20; i++) await post(`ghost-off${i}`)
    expect(events() - before).toBe(0)
  } finally {
    strictAuth = undefined
  }
})

test('positive control: the real hook (node token, node on a board) still records one trusted row', async () => {
  const ws = db.create('ghost-board', dir)
  db.save({ ...ws, nodes: [{ id: 'real1', kind: 'agent', x: 0, y: 0, title: 'Claude' }] } as typeof ws)
  const before = events()
  expect(await post('real1', { [NODE_TOKEN_HEADER]: nodeToken('real1') })).toBe(204)
  expect(events() - before).toBe(1)
  const row = runtime.db.query('SELECT kind, trust, node_id FROM event ORDER BY seq DESC LIMIT 1').get()
  expect(row).toEqual({ kind: 'hook.PostToolUse', trust: 'trusted', node_id: 'real1' })
})
