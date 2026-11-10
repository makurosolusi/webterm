// v26: project.work_auto_done is additive, defaults off for existing rows, and re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { LATEST_VERSION, migrate } from './migration'
import { applyV26 } from './ledgerSchemaV26'

test('v25 -> v26 adds the switch off on existing projects; applying twice keeps the value', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 25))).toBe(25)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  expect(migrate(db)).toBe(LATEST_VERSION)
  const value = () => (db.query(`SELECT work_auto_done AS v FROM project WHERE id = 'p'`).get() as { v: number }).v
  expect(value()).toBe(0)
  db.exec(`UPDATE project SET work_auto_done = 1 WHERE id = 'p'`)
  applyV26(db)
  expect(value()).toBe(1)
})
