// Bun-only: the /m reads over a real ledger (bun:sqlite) and the push/mobile families through the
// REAL router (api.ts), so a reorder that shadows them, or a missing UI-only gate, turns red.
import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wt-push-bun-'))
process.env.WEBTERM_DATA_DIR = root // before ../api -> ../db opens
process.env.HOME = root // test-only
const { handleApi } = await import('../api')
const { openLedgerDb } = await import('../ledger/migration')
const { createEventLog } = await import('../events/eventLog')
const { createEventBus } = await import('../events/eventBus')
const { listMobileAgents } = await import('./mobileAgents')
const { nodeToken } = await import('../hooksTokens')
const { TOKEN_HEADER } = await import('../auth')

const server = http.createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const host = `127.0.0.1:${port}`
afterAll(() => { server.close() })

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://${host}${path}`, init)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const BROWSER = { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` }

test('listMobileAgents: agent nodes only, live first, newest hook preview as last message', () => {
  const db = openLedgerDb(':memory:')
  const log = createEventLog(db, { bus: createEventBus() })
  log.append({ kind: 'hook.UserPromptSubmit', source: 't', trust: 'trusted', nodeId: 'a1', payload: { preview: 'old prompt' } })
  log.append({ kind: 'hook.Stop', source: 't', trust: 'trusted', nodeId: 'a1', payload: { status: 'waiting', preview: 'Done: tests pass' } })
  log.append({ kind: 'fs.change', source: 't', trust: 'trusted', nodeId: 'a1', payload: { preview: 'not a hook' } })
  log.append({ kind: 'hook.Stop', source: 't', trust: 'trusted', nodeId: 'a2', payload: { status: 'done' } })
  const ws = { id: 'w1', name: 'Board', cwd: '/tmp', nodes: [
    { id: 'a1', kind: 'terminal', agentId: 'claude', title: 'Builder', x: 0, y: 0 },
    { id: 'a2', kind: 'terminal', agentId: 'codex', x: 0, y: 0 },
    { id: 't1', kind: 'terminal', x: 0, y: 0 },
  ] }
  const agents = listMobileAgents({
    workspaces: () => [ws as never], statusOf: (id) => (id === 'a1' ? 'waiting' : undefined), isLive: (id) => id === 'a2', ledgerDb: () => db,
  })
  expect(agents.map((a) => a.nodeId)).toEqual(['a2', 'a1'])
  expect(agents[1]).toMatchObject({ title: 'Builder', workspace: 'Board', status: 'waiting', live: false, lastMessage: 'Done: tests pass' })
  expect(agents[0]).toMatchObject({ title: 'codex', status: null, lastMessage: null })
})

test('GET /api/mobile/agents answers through the real router', async () => {
  const r = await call('/api/mobile/agents')
  expect(r.status).toBe(200)
  expect(Array.isArray(r.body.agents)).toBe(true)
})

test('/api/push through the real router: browser page OK, agent token 403', async () => {
  const ok = await call('/api/push', { headers: BROWSER })
  expect(ok.status).toBe(200)
  expect(typeof ok.body.publicKey).toBe('string')
  const agent = await call('/api/push/subscribe', {
    method: 'POST', headers: { ...BROWSER, 'Content-Type': 'application/json', [TOKEN_HEADER]: nodeToken('node-push-1') }, body: '{}',
  })
  expect(agent).toEqual({ status: 403, body: { error: 'agent_cannot_approve' } })
})
