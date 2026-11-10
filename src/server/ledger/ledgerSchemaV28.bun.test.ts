// v28: central_task.goal_version and seq are additive, and re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { migrate } from './migration'
import { applyV28 } from './ledgerSchemaV28'

function atV27(): Database {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 27))).toBe(27)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  db.exec(`INSERT INTO central_task (id, project_id, title, objective, status, acceptance, created_by, created_at, updated_at) VALUES ('t', 'p', 't', 'o', 'todo', 'review', 'central', 0, 0)`)
  return db
}
const row = (db: Database) => db.query(`SELECT goal_version AS g, seq AS s FROM central_task WHERE id = 't'`).get() as { g: number | null; s: number | null }

test('v27 -> v28 keeps existing tasks unlinked; applying twice keeps the values', () => {
  const db = atV27()
  migrate(db)
  expect(row(db)).toEqual({ g: null, s: null })
  db.exec(`UPDATE central_task SET goal_version = 3, seq = 4 WHERE id = 't'`)
  applyV28(db)
  expect(row(db)).toEqual({ g: 3, s: 4 })
})

test('the goal link is indexed by project and version', () => {
  const db = atV27()
  migrate(db)
  const columns = db.query(`PRAGMA index_info(idx_central_task_goal)`).all() as Array<{ name: string }>
  expect(columns.map((c) => c.name)).toEqual(['project_id', 'goal_version'])
})
