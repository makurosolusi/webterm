// v25: central work tables are additive, re-applying is a no-op, and retention follows the settled rule.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { SETTLED_RETENTION_MS } from './ledgerRetention.policy'
import { sweepRetention } from './ledgerRetention'
import { LATEST_VERSION, migrate } from './migration'
import { applyV25 } from './ledgerSchemaV25'

const NOW = 1_800_000_000_000 // test-only fixed clock
const OLD = NOW - SETTLED_RETENTION_MS - 1

function seeded(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  return db
}
const putTask = (db: Database, id: string, status: string, at: number) => db.query(`INSERT INTO central_task
  (id, project_id, title, objective, status, created_by, created_at, updated_at) VALUES (?, 'p', 't', 'o', ?, 'central', ?, ?)`).run(id, status, at, at)
const putAssignment = (db: Database, id: string, taskId: string, endedAt: number | null) => db.query(`INSERT INTO central_assignment
  (id, task_id, project_id, node_id, channel, instruction, attempt, started_at, ended_at) VALUES (?, ?, 'p', 'n', 'chat', 'i', 1, 0, ?)`).run(id, taskId, endedAt)
const ids = (db: Database, table: string): string[] => (db.query(`SELECT id FROM ${table}`).all() as { id: string }[]).map((r) => r.id).sort()
const failure = (fn: () => unknown): string => {
  try { fn() } catch (err) { return String(err) }
  return 'no_error'
}
const names = (db: Database, type: string): string[] => (db.query('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name)

test('v24 -> v25 adds the tables and indexes; applying twice keeps the rows', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 24))).toBe(24)
  expect(names(db, 'table')).not.toContain('central_task')
  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(names(db, 'table')).toEqual(expect.arrayContaining(['central_task', 'central_task_dep', 'central_assignment']))
  expect(names(db, 'index')).toEqual(expect.arrayContaining(['idx_central_task_project_board', 'idx_central_task_board', 'idx_central_assignment_open_node', 'idx_central_assignment_task', 'idx_event_correlation']))
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  putTask(db, 'x', 'todo', 1)
  applyV25(db)
  applyV25(db)
  expect(ids(db, 'central_task')).toEqual(['x'])
})

test('the schema refuses an unknown status, acceptance and channel', () => {
  const db = seeded()
  expect(failure(() => putTask(db, 'x', 'bogus', 1))).toContain('CHECK')
  putTask(db, 'x', 'todo', 1)
  expect(failure(() => db.exec(`UPDATE central_task SET acceptance = 'magic' WHERE id = 'x'`))).toContain('CHECK')
  expect(failure(() => db.exec(`INSERT INTO central_assignment (id, task_id, project_id, node_id, channel, instruction, attempt, started_at) VALUES ('a', 'x', 'p', 'n', 'carrier-pigeon', 'i', 1, 0)`))).toContain('CHECK')
})

test('retention sweeps settled tasks past the age; deps and assignments cascade', () => {
  const db = seeded()
  putTask(db, 'old-done', 'done', OLD); putTask(db, 'old-cancelled', 'cancelled', OLD); putTask(db, 'old-failed', 'failed', OLD)
  putTask(db, 'old-todo', 'todo', OLD); putTask(db, 'old-running', 'running', OLD); putTask(db, 'recent-done', 'done', NOW - 1000)
  putAssignment(db, 'a-ended', 'old-done', 1)
  db.exec(`INSERT INTO central_task_dep (task_id, blocked_by_id) VALUES ('old-done', 'old-cancelled')`)
  sweepRetention({ db, now: () => NOW }, NOW)
  expect(ids(db, 'central_task')).toEqual(['old-running', 'old-todo', 'recent-done'])
  expect(ids(db, 'central_assignment')).toEqual([])
  expect(db.query('SELECT COUNT(*) AS n FROM central_task_dep').get()).toEqual({ n: 0 })
})

test('retention keeps a settled task with an open assignment or an unsettled dependent', () => {
  const db = seeded()
  putTask(db, 'open', 'failed', OLD); putAssignment(db, 'a-open', 'open', null)
  putTask(db, 'dep', 'cancelled', OLD); putTask(db, 'waiting', 'blocked', OLD)
  db.exec(`INSERT INTO central_task_dep (task_id, blocked_by_id) VALUES ('waiting', 'dep')`)
  sweepRetention({ db, now: () => NOW }, NOW)
  expect(ids(db, 'central_task')).toEqual(['dep', 'open', 'waiting'])
  expect(ids(db, 'central_assignment')).toEqual(['a-open'])
})
