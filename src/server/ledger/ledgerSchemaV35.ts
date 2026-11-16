/**
 * v35: `central_checkin_reason.conversation_id` (where the question that caused the reason was asked).
 *
 * Why: a check-in used to be routed by the task's project, so an answer to a question asked in `central:global` landed
 * in `central:project:<id>` where the user was not looking. Storing the originating conversation lets delivery return
 * the result to where it was asked. NULL = no known origin (falls back to project, then global).
 * Idempotent (guarded ALTER); the backfill covers only reasons not yet sent, from the task's own conversation.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV35(db: Database): void {
  if (!addColumnIfMissing(db, 'central_checkin_reason', 'conversation_id', 'TEXT')) return
  db.exec(`UPDATE central_checkin_reason SET conversation_id = (SELECT t.conversation_id FROM central_task t WHERE t.id = central_checkin_reason.task_id)
    WHERE sent_at IS NULL AND conversation_id IS NULL AND task_id IS NOT NULL`)
}
