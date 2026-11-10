/**
 * v29: Central's time awareness.
 *
 * `central_reminder` is what Central asked to be told about later. `central_checkin_reason` is the durable queue of
 * things the supervisor found that need a decision: it has to survive a restart, and `dedupe_key` makes a trigger
 * fire once. Delivered rows stay (with `sent_at`) so an overdue task never fires again.
 * `central_turn.origin` separates the turns Central started itself, which is what the daily budget counts;
 * existing turns were all typed by a person, hence the default. Additive and idempotent (IF NOT EXISTS, guarded ALTER).
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export const DDL_V29 = `
CREATE TABLE IF NOT EXISTS central_reminder (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES central_task(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
  created_by TEXT NOT NULL,
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_central_reminder_status_due ON central_reminder(status, due_at);
CREATE TABLE IF NOT EXISTS central_checkin_reason (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES central_task(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  turn_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_central_checkin_reason_queue ON central_checkin_reason(sent_at, created_at);
CREATE INDEX IF NOT EXISTS idx_central_task_due ON central_task(due_at) WHERE due_at IS NOT NULL;
`

export function applyV29(db: Database): void {
  db.exec(DDL_V29)
  addColumnIfMissing(db, 'central_turn', 'origin', "TEXT NOT NULL DEFAULT 'user'")
  db.exec('CREATE INDEX IF NOT EXISTS idx_central_turn_origin_started ON central_turn(origin, started_at)')
}
