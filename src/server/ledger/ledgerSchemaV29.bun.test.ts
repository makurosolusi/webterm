// v29: reminders, the check-in queue and central_turn.origin are additive, and re-applying is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { RETENTION } from './ledgerRetention.policy'
import { LATEST_VERSION, migrate } from './migration'
import { applyV29 } from './ledgerSchemaV29'

const DAY = 86_400_000
const count = (db: Database, table: string): number => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

function atV28(): Database {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 28))
  db.exec(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at) VALUES ('t', 'c', 'm', 'succeeded', 0)`)
  return db
}

test('existing turns become user turns and applying twice keeps the rows', () => {
  const db = atV28()
  expect(migrate(db)).toBe(LATEST_VERSION)
  const origin = () => (db.query(`SELECT origin FROM central_turn WHERE id = 't'`).get() as { origin: string }).origin
  expect(origin()).toBe('user')
  db.exec(`UPDATE central_turn SET origin = 'system'`)
  db.exec(`INSERT INTO central_reminder (id, text, due_at, created_by, created_at) VALUES ('r', 'x', 1, 'central', 0)`)
  applyV29(db)
  expect(origin()).toBe('system')
  expect(count(db, 'central_reminder')).toBe(1)
})

test('a reminder status outside the three values is refused', () => {
  const db = atV28()
  migrate(db)
  let threw = false
  try { db.exec(`INSERT INTO central_reminder (id, text, due_at, status, created_by, created_at) VALUES ('r', 'x', 1, 'done', 'central', 0)`) } catch { threw = true }
  expect(threw).toBe(true)
})

test('retention sweeps settled rows, keeps open ones and every overdue marker', () => {
  const db = atV28()
  migrate(db)
  const ctx = { db, now: () => 100 * DAY }
  db.exec(`INSERT INTO central_reminder (id, text, due_at, status, created_by, created_at) VALUES ('old', 'x', 1, 'fired', 'c', 0), ('wait', 'x', 1, 'pending', 'c', 0)`)
  db.exec(`INSERT INTO central_checkin_reason (id, dedupe_key, kind, text, created_at, sent_at) VALUES ('a', 'a', 'reminder_due', 'x', 0, 1), ('b', 'b', 'task_stalled', 'x', 0, NULL), ('c', 'c', 'task_overdue', 'x', 0, 1)`)
  for (const table of ['central_reminder', 'central_checkin_reason']) {
    const entry = RETENTION[table]
    if (entry?.kind !== 'sweep') throw new Error(`${table} has no sweep`)
    expect(entry.sweep(ctx, ctx.now(), 10)).toBe(1)
  }
  expect((db.query('SELECT id FROM central_reminder').all() as { id: string }[]).map((r) => r.id)).toEqual(['wait'])
  expect((db.query('SELECT id FROM central_checkin_reason ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual(['b', 'c'])
})
