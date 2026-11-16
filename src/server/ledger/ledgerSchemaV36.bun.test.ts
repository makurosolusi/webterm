// v36: central_assignment.lease_until is added once; open assignments are backfilled from their last signal and task status.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { LATEST_VERSION, migrate } from './migration'
import { applyV36 } from './ledgerSchemaV36'

function atV35(): Database {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 35))
  return db
}
function seed(db: Database, id: string, status: string, lastSignalAt: number | null, ended: number | null): void {
  db.query("INSERT INTO central_task (id, project_id, title, objective, status, created_by, created_at, updated_at) VALUES (?, 'p1', 'T', 'o', ?, 'central', 1, 1)").run(id, status)
  db.query("INSERT INTO central_assignment (id, task_id, project_id, node_id, channel, instruction, attempt, started_at, last_signal_at, ended_at) VALUES (?, ?, 'p1', ?, 'chat', 'i', 1, 1000, ?, ?)").run(`a-${id}`, id, `n-${id}`, lastSignalAt, ended)
}
const leases = (db: Database): Record<string, number | null> =>
  Object.fromEntries((db.query('SELECT task_id AS t, lease_until AS l FROM central_assignment').all() as { t: string; l: number | null }[]).map((r) => [r.t, r.l]))

test('backfills open assignments from last signal (else start) plus the status window, leaves ended ones NULL, and re-applying keeps values', () => {
  const db = atV35()
  seed(db, 'run', 'running', 5000, null); seed(db, 'asg', 'assigned', null, null); seed(db, 'rep', 'reported', 7000, null)
  seed(db, 'rev', 'needs_review', 2000, null); seed(db, 'end', 'done', 3000, 9000)
  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(leases(db)).toEqual({ run: 365000, asg: 61000, rep: 607000, rev: 902000, end: null })
  db.exec("UPDATE central_assignment SET lease_until = 42 WHERE task_id = 'run'")
  applyV36(db)
  expect(leases(db)['run']).toBe(42)
})
