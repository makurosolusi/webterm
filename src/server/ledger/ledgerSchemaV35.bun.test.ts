// v35: central_checkin_reason.conversation_id is added once, unsent reasons are backfilled from their task, sent ones are not.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { LATEST_VERSION, migrate } from './migration'
import { applyV35 } from './ledgerSchemaV35'

function atV34(): Database {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 34))
  return db
}
const reason = (db: Database, id: string, taskId: string | null, sent: number | null): void => {
  db.query('INSERT INTO central_checkin_reason (id, dedupe_key, kind, task_id, text, created_at, sent_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, id, 'task_stalled', taskId, 'x', sent)
}
const conv = (db: Database): Record<string, string | null> =>
  Object.fromEntries((db.query('SELECT id, conversation_id AS c FROM central_checkin_reason').all() as { id: string; c: string | null }[]).map((r) => [r.id, r.c]))

test('backfills unsent reasons from the task, leaves sent and task-less ones NULL, and re-applying is a no-op', () => {
  const db = atV34()
  db.exec("INSERT INTO central_task (id, project_id, title, objective, status, created_by, conversation_id, created_at, updated_at) VALUES ('t1','p1','T','o','todo','central','central:global',1,1)")
  reason(db, 'open', 't1', null); reason(db, 'sent', 't1', 5); reason(db, 'free', null, null)
  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(conv(db)).toEqual({ open: 'central:global', sent: null, free: null })
  db.exec("UPDATE central_checkin_reason SET conversation_id = 'central:chat:x' WHERE id = 'open'")
  applyV35(db)
  expect(conv(db)['open']).toBe('central:chat:x')
})
