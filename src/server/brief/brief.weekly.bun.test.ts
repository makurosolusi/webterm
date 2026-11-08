// Bun-only (bun:sqlite): the brief's weekly cost lines from seeded cost / DAG / Central turn rows.
import { expect, test } from 'bun:test'
import { openLedgerDb } from '../ledger/migration'
import { execWrite } from '../ledger/ledgerCore'
import { ensureCostSchema, insertCostUsage } from '../cost/costStore'
import { readWeekly, WEEK_MS } from './brief.source'
import { weeklyLines } from './brief.model'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000

test('weekly lines: spend by kind and model/tier, cost per verified task, Central failure rate', () => {
  const db = openLedgerDb(':memory:')
  ensureCostSchema(db)
  db.exec('PRAGMA foreign_keys = OFF') // test-only: dag_task rows without their dag/project
  const row = (key: string, ts: number, source: 'agent' | 'central' | 'helper', model: string | null, costMicros: number) =>
    insertCostUsage(db, { key, ts, source, workspaceId: null, nodeId: null, sessionId: null, model, input: 1, output: 1, cacheRead: 0, write5m: 0, write1h: 0, costMicros })
  row('a', NOW - DAY, 'central', 'claude-sonnet-5-5', 2_000_000)
  row('b', NOW - 2 * DAY, 'agent', 'claude-opus-5-5', 5_000_000)
  row('c', NOW - 3 * DAY, 'helper', 'claude-haiku-5-5', 500_000)
  row('d', NOW - 3 * DAY, 'agent', 'claude-opus-4-1', 1_000_000) // another opus id: merges under opus
  row('old', NOW - WEEK_MS - DAY, 'agent', 'claude-opus-5-5', 9_000_000) // outside the window
  execWrite(db, "INSERT INTO cost_run (id, kind, ref, started_at, ended_at, cost_micros) VALUES ('r1', 'dag', 'd1', ?, ?, 3000000)", NOW - DAY, NOW - DAY)
  for (const [id, status] of [['t1', 'done'], ['t2', 'done'], ['t3', 'failed']] as const) {
    execWrite(db, "INSERT INTO dag_task (id, dag_id, key, kind, brief_json, status, created_at, updated_at) VALUES (?, 'd1', ?, 'work', '{}', ?, ?, ?)", id, id, status, NOW - DAY, NOW - DAY)
  }
  for (const [id, status] of [['u1', 'succeeded'], ['u2', 'succeeded'], ['u3', 'succeeded'], ['u4', 'failed']] as const) {
    execWrite(db, "INSERT INTO central_turn (id, conversation_id, message_id, status, started_at, ended_at) VALUES (?, 'central:global', 'm', ?, ?, ?)", id, status, NOW - DAY, NOW - DAY)
  }

  const texts = weeklyLines(readWeekly(db, NOW)).map((l) => l.text)
  expect(texts).toEqual([
    'Last 7 days: $8.50 (agent $6.00, central $2.00, helper $0.50)',
    'By model: opus (T3) $6.00, sonnet (T2) $2.00, haiku (T1) $0.50',
    'Cost per verified task: $1.50 (2 tasks)',
    'Central turns: 4, 1 failed (25%)',
  ])
})

test('weekly lines are empty for a quiet week', () => {
  const db = openLedgerDb(':memory:')
  expect(weeklyLines(readWeekly(db, NOW))).toEqual([])
})
