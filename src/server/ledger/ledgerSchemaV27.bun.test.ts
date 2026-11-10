// v27: central_state and central_turn.context_json are additive, and re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { RETENTION } from './ledgerRetention.policy'
import { LATEST_VERSION, migrate } from './migration'
import { applyV27 } from './ledgerSchemaV27'

function atV26(): Database {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 26))).toBe(26)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  db.exec(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES ('t', 'c', 'm', 'succeeded', 0)`)
  return db
}
const insertState = (db: Database, key: string, projectId: string | null) =>
  db.query(`INSERT INTO central_state (scope_key, project_id, body, version, updated_at, updated_by) VALUES (?, ?, 'b', 1, 0, 'central')`).run(key, projectId)

// The bun:test typings here have no toThrow.
function threw(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

test('v26 -> v27 keeps existing turns with a NULL trace; applying twice keeps the rows', () => {
  const db = atV26()
  expect(migrate(db)).toBe(LATEST_VERSION)
  const trace = () => db.query(`SELECT context_json AS j FROM central_turn WHERE id = 't'`).get() as { j: string | null }
  expect(trace().j).toBeNull()
  insertState(db, 'global', null)
  db.exec(`UPDATE central_turn SET context_json = '{}' WHERE id = 't'`)
  applyV27(db)
  expect(trace().j).toBe('{}')
  expect((db.query('SELECT COUNT(*) AS n FROM central_state').get() as { n: number }).n).toBe(1)
})

test('a project row cascades with its project and the scope key must match the project', () => {
  const db = atV26()
  migrate(db)
  db.exec('PRAGMA foreign_keys = ON')
  insertState(db, 'project:p', 'p')
  expect(threw(() => insertState(db, 'project:other', 'p'))).toBe(true)
  expect(threw(() => insertState(db, 'global', 'p'))).toBe(true)
  db.exec(`DELETE FROM project WHERE id = 'p'`)
  expect((db.query('SELECT COUNT(*) AS n FROM central_state').get() as { n: number }).n).toBe(0)
})

test('central_state has a retention entry', () => {
  expect(RETENTION.central_state?.kind).toBe('exempt')
})
