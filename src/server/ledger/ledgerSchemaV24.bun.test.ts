// v24: cost_run gains nullable tier/model; existing rows survive, re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LATEST_VERSION, migrate } from './migration'
import { MIGRATIONS } from './ledgerSchema'
import { applyV24 } from './ledgerSchemaV24'

const columns = (db: Database): string[] => (db.query('PRAGMA table_info(cost_run)').all() as { name: string }[]).map((c) => c.name)

test('v23 -> v24 adds cost_run.tier/model, keeps rows; applying twice is safe', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 23))).toBe(23)
  db.exec(`INSERT INTO cost_run (id, kind, ref, started_at, ended_at, cost_micros) VALUES ('r1', 'routine', 'rt', 1, 2, 500)`)
  expect(columns(db)).not.toContain('tier')
  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(columns(db)).toEqual(expect.arrayContaining(['tier', 'model']))
  applyV24(db)
  applyV24(db)
  expect(db.query('SELECT id, cost_micros, tier, model FROM cost_run').all()).toEqual([{ id: 'r1', cost_micros: 500, tier: null, model: null }])
  db.exec(`INSERT INTO cost_run (id, kind, ref, started_at, tier, model) VALUES ('r2', 'dag', 'd', 1, 'T2', 'sonnet')`)
  expect(db.query("SELECT tier, model FROM cost_run WHERE id = 'r2'").get()).toEqual({ tier: 'T2', model: 'sonnet' })
})
