// Worker cost rows carry the ladder tier of their agent; costByTier sums by kind x tier x model; v38 backfills once.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../ledger/ledgerSchema'
import { applyV38 } from '../ledger/ledgerSchemaV38'
import { LATEST_VERSION, migrate, openLedgerDb } from '../ledger/migration'
import { captureTranscript } from './costCapture'
import { costRoute } from './cost.route'
import { costByTier, insertCostUsage } from './costStore'

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0) // test-only clock
const root = mkdtempSync(join(tmpdir(), 'cost-tier-'))
const prevConfig = process.env.CLAUDE_CONFIG_DIR
const prevData = process.env.WEBTERM_DATA_DIR
process.env.CLAUDE_CONFIG_DIR = root // test-only: never read the real transcripts
process.env.WEBTERM_DATA_DIR = join(root, 'data') // test-only
afterAll(() => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfig
  if (prevData === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevData
  rmSync(root, { recursive: true, force: true })
})

let db: Database
beforeEach(() => { db = openLedgerDb(':memory:') })

const line = (id: string, ts = T0): string => `${JSON.stringify({
  type: 'assistant', sessionId: 'sess-1', timestamp: new Date(ts).toISOString(), cwd: '/secret/cwd',
  message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'TRANSCRIPT-SECRET' }], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
})}\n`
function transcript(name: string, body: string): string {
  const dir = join(root, 'projects', '-tmp-tier')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, body)
  return path
}
function agent(d: Database, id: string, nodeId: string, startedAt: number, budgetJson: string | null): void {
  d.query(`INSERT INTO central_agents (id, project_id, node_id, kind, runner, state, owner, budget_json, started_at)
    VALUES (?, 'p1', ?, 'claude', 'pty', 'running', 'human', ?, ?)`).run(id, nodeId, budgetJson, startedAt)
}
const ladder = (tier: string): string => JSON.stringify({ ladder: { pick: { model: 'm', effort: 'high', tier, reason: 'r' } } })
const tierOf = (d: Database, key: string): unknown => (d.query('SELECT tier FROM cost_usage WHERE key = ?').get(key) as { tier: unknown }).tier

test('capture stamps the tier of the agent on the node; no ladder = unknown; no agent = null', () => {
  agent(db, 'a1', 'nT', T0 - 10, ladder('T2'))
  agent(db, 'a2', 'nU', T0 - 10, null)
  captureTranscript(db, { path: transcript('t-a', line('m_t')), nodeId: 'nT', workspaceId: null }, () => T0)
  captureTranscript(db, { path: transcript('t-b', line('m_u')), nodeId: 'nU', workspaceId: null }, () => T0)
  captureTranscript(db, { path: transcript('t-c', line('m_h')), nodeId: 'nH', workspaceId: null }, () => T0)
  expect([tierOf(db, 'cc:m_t'), tierOf(db, 'cc:m_u'), tierOf(db, 'cc:m_h')]).toEqual(['T2', 'unknown', null])
})

test('a later agent on the same node does not retier earlier responses', () => {
  agent(db, 'a1', 'n1', T0 - 100, ladder('T1'))
  agent(db, 'a2', 'n1', T0 + 100, ladder('T3'))
  captureTranscript(db, { path: transcript('t-d', line('m_old', T0) + line('m_new', T0 + 200)), nodeId: 'n1', workspaceId: null }, () => T0)
  expect([tierOf(db, 'cc:m_old'), tierOf(db, 'cc:m_new')]).toEqual(['T1', 'T3'])
})

const row = (key: string, o: Partial<Parameters<typeof insertCostUsage>[1]>) => ({
  key, ts: T0, source: 'agent' as const, workspaceId: null, nodeId: 'n1', sessionId: key, model: 'claude-opus-5-5',
  input: 1, output: 1, cacheRead: 0, write5m: 0, write1h: 0, costMicros: 100, ...o,
})

test('costByTier sums per kind x tier x model, filters sinceMs and returns no transcript content', () => {
  insertCostUsage(db, row('a', { tier: 'T2', costMicros: 100, sessionId: 's1' }))
  insertCostUsage(db, row('b', { tier: 'T2', costMicros: 50, sessionId: 's1' }))
  insertCostUsage(db, row('c', { tier: 'T2', costMicros: 10, sessionId: 's2', model: 'claude-haiku-5-5' }))
  insertCostUsage(db, row('d', { tier: null, costMicros: 5, source: 'helper' }))
  insertCostUsage(db, row('old', { tier: 'T2', ts: T0 - 1000, costMicros: 9999 }))
  const got = costByTier(db, { sinceMs: T0 })
  expect(got).toEqual([
    { kind: 'agent', tier: 'T2', model: 'claude-opus-5-5', runs: 1, costMicros: 150 },
    { kind: 'agent', tier: 'T2', model: 'claude-haiku-5-5', runs: 1, costMicros: 10 },
    { kind: 'helper', tier: null, model: 'claude-opus-5-5', runs: 1, costMicros: 5 },
  ])
  captureTranscript(db, { path: transcript('t-e', line('m_x')), nodeId: 'n9', workspaceId: null }, () => T0)
  expect(JSON.stringify(costByTier(db, { sinceMs: 0 }))).not.toContain('TRANSCRIPT-SECRET')
})

test('GET /api/cost/by-tier serves it; bad since is 400', async () => {
  insertCostUsage(db, row('a', { tier: 'T0', costMicros: 7 }))
  const ok = await costRoute('/api/cost/by-tier', 'GET', new URLSearchParams({ sinceMs: String(T0) }), async () => '', { db, now: T0 })
  expect(ok?.status).toBe(200)
  expect(ok?.body).toEqual([{ kind: 'agent', tier: 'T0', model: 'claude-opus-5-5', runs: 1, costMicros: 7 }])
  const bad = await costRoute('/api/cost/by-tier', 'GET', new URLSearchParams({ sinceMs: 'x' }), async () => '', { db, now: T0 })
  expect(bad?.status).toBe(400)
})

test('v38 adds the column once, backfills existing worker rows from their agent, and re-running changes nothing', () => {
  const old = new Database(':memory:')
  migrate(old, MIGRATIONS.filter((m) => m.version <= 37))
  expect(old.query('PRAGMA table_info(cost_usage)').all().some((c) => (c as { name: string }).name === 'tier')).toBe(false)
  agent(old, 'a1', 'n1', T0 - 10, ladder('T4'))
  agent(old, 'a2', 'n2', T0 - 10, null)
  for (const [key, node, source] of [['r1', 'n1', 'agent'], ['r2', 'n2', 'agent'], ['r3', 'n3', 'agent'], ['r4', 'n1', 'helper']] as const) {
    old.query(`INSERT INTO cost_usage (key, ts, source, node_id, model, input, output, cache_read, cache_write_5m, cache_write_1h, cost_micros, price_known)
      VALUES (?, ?, ?, ?, 'm', 1, 1, 0, 0, 0, 1, 1)`).run(key, T0, source, node)
  }
  expect(migrate(old)).toBe(LATEST_VERSION)
  const tiers = (): unknown[] => old.query('SELECT key, tier FROM cost_usage ORDER BY key').all()
  const expected = [{ key: 'r1', tier: 'T4' }, { key: 'r2', tier: 'unknown' }, { key: 'r3', tier: null }, { key: 'r4', tier: null }]
  expect(tiers()).toEqual(expected)
  old.query("UPDATE cost_usage SET tier = 'X' WHERE key = 'r1'").run()
  applyV38(old)
  applyV38(old)
  expect(tierOfRow(old, 'r1')).toBe('X') // a second run neither re-adds the column nor re-runs the backfill
})
const tierOfRow = (d: Database, key: string): unknown => (d.query('SELECT tier FROM cost_usage WHERE key = ?').get(key) as { tier: unknown }).tier
