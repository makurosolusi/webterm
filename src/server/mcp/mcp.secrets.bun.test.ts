// Bun-only: secret.run / secret.list as MCP tools go through the same broker as `/api/tools/secret.*`
// (policy per secret, ask by default, masked output, secret.use receipt events) on the real ledger schema.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '../../shared/workspace'
import { freshDb, rows } from '../central/guard/controlGuard.testutil'
import { createEventLog } from '../events/eventLog'
import { createPolicy } from '../policy/policy.decide'
import { createBrokerStore } from '../secrets/secret.store'
import { callTool, listTools, type McpDeps } from './mcp.tools'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mcp-secrets-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const work = join(root, 'work')
mkdirSync(work)
const VALUE = 'test-only-mcp-s3cr3t-value' // test-only fixture, never a real credential
const BOARD = [{ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, cwd: work, updatedAt: 0, bridges: [], nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }] }] as unknown as Workspace[]

function setup() {
  const db = freshDb()
  const events = createEventLog(db)
  const policy = createPolicy({ db, events })
  const store = createBrokerStore(join(root, `store-${Math.random().toString(36).slice(2)}`))
  store.write('NPM_TOKEN', VALUE)
  const deps: McpDeps = {
    policy, workspaces: () => BOARD, central: null, browser: null, events,
    gitDiff: async () => ({ status: 200, body: {} }), secrets: { store, lastUsed: () => new Map() },
  }
  return { db, policy, deps }
}
const printer = ['/bin/sh', '-c', 'echo "tok=$NPM_TOKEN len=${#NPM_TOKEN}"']

test('tools/list carries secret_run and secret_list with their registry schemas', () => {
  const tools = listTools({ central: null })
  const run = tools.find((t) => t.name === 'secret_run')
  const list = tools.find((t) => t.name === 'secret_list')
  expect(run?.description).toContain('webterm secret.run, tier R2')
  expect((run?.inputSchema as { required: string[] }).required).toEqual(['names', 'command'])
  expect(list?.annotations?.readOnlyHint).toBe(true)
})

test('secret_list answers names only; secret_run is denied without a grant and masked with one', async () => {
  const { db, policy, deps } = setup()
  const listed = await callTool(deps, 'a1', 'tok', 'secret_list', {})
  expect(listed.outcome).toBe('ok')
  expect(listed.data).toEqual({ secrets: [{ name: 'NPM_TOKEN', lastUsedAt: null }] })

  const asked = await callTool(deps, 'a1', 'tok', 'secret_run', { names: ['NPM_TOKEN'], command: printer })
  expect([asked.outcome, asked.detail]).toEqual(['denied', 'approval_required'])
  expect(asked.data).toBeNull()

  policy.createGrant('human-ui', { subject: 'node:a1', capability: 'secret.run', scope: 'secret:NPM_TOKEN:/bin/sh*', effect: 'allow' })
  const ran = await callTool(deps, 'a1', 'tok', 'secret_run', { names: ['NPM_TOKEN'], command: printer })
  expect(ran.outcome).toBe('ok')
  const out = ran.data as { stdout: string; exitCode: number }
  expect(out.exitCode).toBe(0)
  expect(out.stdout).toContain(`len=${VALUE.length}`)
  expect(out.stdout).not.toContain(VALUE)
  expect(JSON.stringify(ran)).not.toContain(VALUE)
  expect(JSON.stringify(rows(db, 'SELECT * FROM event'))).not.toContain(VALUE)
  expect(rows(db, "SELECT kind FROM event WHERE kind IN ('secret.use', 'mcp.call')").map((r) => r.kind).sort())
    .toEqual(['mcp.call', 'mcp.call', 'mcp.call', 'secret.use'])
}, 30_000)

test('ledger off: secret_run fails closed', async () => {
  const { deps } = setup()
  const r = await callTool({ ...deps, policy: null }, 'a1', 'tok', 'secret_run', { names: ['NPM_TOKEN'], command: printer })
  expect([r.outcome, r.detail]).toEqual(['denied', 'policy_unavailable'])
})
