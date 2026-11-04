// v17 takes over the cost tables and routine_run.estimate_usd that v16-era modules created on first use.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LATEST_VERSION, migrate } from './migration'
import { MIGRATIONS } from './ledgerSchema'
import { DDL_V17, applyV17 } from './ledgerSchemaV17'

const userVersion = (db: Database) => Number((db.query('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])

test('a v16 install whose modules already created the cost tables and estimate_usd keeps every row', () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 16))).toBe(16)
  // What costStore.ensureCostSchema and createRoutineStore did before v17 (same DDL, same ALTER).
  db.exec(DDL_V17)
  db.exec('ALTER TABLE routine_run ADD COLUMN estimate_usd REAL')
  db.exec(`INSERT INTO cost_usage (key, ts, source, input, output, cache_read, cache_write_5m, cache_write_1h, cost_micros, price_known)
    VALUES ('msg-1', 1, 'agent', 10, 20, 0, 0, 0, 1500, 1)`)
  db.exec(`INSERT INTO cost_run (id, kind, ref, node_id, started_at, ended_at, cost_micros) VALUES ('run-1', 'dag', 'd1', 'n1', 1, 2, 1500)`)
  db.exec(`INSERT INTO cost_cap (scope, limit_micros) VALUES ('day', 5000000)`)
  db.exec(`INSERT INTO routine (id, name, trigger_json, action_json, budget_json, created_at, updated_at) VALUES ('r1', 'n', '{}', '{}', '{}', 1, 1)`)
  db.exec(`INSERT INTO routine_run (id, routine_id, trigger, status, started_at, estimate_usd) VALUES ('rr1', 'r1', 'manual', 'ran', 1, 0.42)`)

  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(userVersion(db) >= 17).toBe(true)
  expect(db.query('SELECT cost_micros FROM cost_usage WHERE key = ?').get('msg-1')).toEqual({ cost_micros: 1500 })
  expect(db.query('SELECT cost_micros FROM cost_run WHERE id = ?').get('run-1')).toEqual({ cost_micros: 1500 })
  expect(db.query('SELECT limit_micros FROM cost_cap WHERE scope = ?').get('day')).toEqual({ limit_micros: 5000000 })
  expect(db.query('SELECT estimate_usd FROM routine_run WHERE id = ?').get('rr1')).toEqual({ estimate_usd: 0.42 })
  // Re-running the step is a no-op.
  applyV17(db)
  expect(db.query('SELECT COUNT(*) AS n FROM cost_usage').get()).toEqual({ n: 1 })
})

test('a fresh ledger gets the cost tables and estimate_usd from migrations alone', () => {
  const db = new Database(':memory:')
  migrate(db)
  for (const t of ['cost_usage', 'cost_run', 'cost_cap']) expect(db.query(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)).toBeTruthy()
  const cols = (db.query('PRAGMA table_info(routine_run)').all() as { name: string }[]).map((c) => c.name)
  expect(cols).toContain('estimate_usd')
})
