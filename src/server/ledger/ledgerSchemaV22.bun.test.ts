// v22: event time-range indexes (used by replay's query plan) and cost_run admitting 'bakeoff'.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LATEST_VERSION, migrate } from './migration'
import { MIGRATIONS } from './ledgerSchema'
import { applyV22 } from './ledgerSchemaV22'

/** Message thrown by fn, or '' (the bun:test typings here have no toThrow). */
const errorOf = (fn: () => void): string => { try { fn(); return '' } catch (e) { return String(e) } }
const plan =(db: Database, sql: string, ...args: unknown[]): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as [])) as { detail: string }[]).map((r) => r.detail).join('\n')

test('v21 -> v22 adds the event indexes, keeps cost_run rows, admits bakeoff; re-run is a no-op', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 21))).toBe(21)
  db.exec(`INSERT INTO cost_run (id, kind, ref, started_at, ended_at, cost_micros) VALUES ('r1', 'routine', 'rt', 1, 2, 500)`)
  expect(errorOf(() => db.exec(`INSERT INTO cost_run (id, kind, ref, started_at) VALUES ('b0', 'bakeoff', 'b', 1)`))).toContain('CHECK constraint failed')
  expect(migrate(db)).toBe(LATEST_VERSION)
  const idx = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event'").all() as { name: string }[]).map((r) => r.name)
  expect(idx).toEqual(expect.arrayContaining(['idx_event_ts', 'idx_event_node_ts']))
  db.exec(`INSERT INTO cost_run (id, kind, ref, started_at) VALUES ('b1', 'bakeoff', 'b', 1)`)
  expect(errorOf(() => db.exec(`INSERT INTO cost_run (id, kind, ref, started_at) VALUES ('x', 'other', 'b', 1)`))).toContain('CHECK constraint failed')
  applyV22(db)
  applyV22(db)
  expect(db.query('SELECT id, kind, cost_micros FROM cost_run ORDER BY id').all()).toEqual([
    { id: 'b1', kind: 'bakeoff', cost_micros: null }, { id: 'r1', kind: 'routine', cost_micros: 500 },
  ])
  expect(plan(db, 'SELECT * FROM cost_run WHERE kind = ? AND ref = ? ORDER BY ended_at', 'routine', 'rt')).toContain('idx_cost_run_ref')
})

test("replay's event query (node and workspace scope) is planned on a v22 index, not a full scan", () => {
  const db = new Database(':memory:')
  migrate(db)
  const node = plan(db, "SELECT seq FROM event WHERE hash IS NOT NULL AND ts >= ? AND ts < ? AND node_id = ? AND kind LIKE 'hook.%' ORDER BY ts ASC, seq ASC LIMIT ?", 0, 10, 'n1', 5)
  expect(node).toContain('idx_event_node_ts')
  const ws = plan(db, "SELECT seq FROM event WHERE hash IS NOT NULL AND ts >= ? AND ts < ? AND (workspace_id = ? OR node_id IN (SELECT value FROM json_each(?))) ORDER BY ts ASC, seq ASC LIMIT ?", 0, 10, 'w', '[]', 5)
  expect(ws).toContain('idx_event_ts')
})
