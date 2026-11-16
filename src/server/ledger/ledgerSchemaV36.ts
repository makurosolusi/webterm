/**
 * v36: `central_assignment.lease_until` (when the current owner of an open task must have acted, epoch ms).
 *
 * Why: a task in `reported`/`verifying`/`needs_review` had no owner and no deadline, and the liveness clock was derived
 * from old signal times, so a restart made every stale signal fire at once. A stored lease is renewed by every signal and
 * status move and read back after a restart. NULL = ended before this version (no owner left to wait for).
 * Idempotent (guarded ALTER, backfill only on the run that adds the column). The backfill gives each OPEN assignment
 * `last_signal_at (else started_at) + the window of its task status`; the windows are frozen here on purpose (migrations
 * must not follow later constants): assigned 1 min, running 6 min, reported/verifying 10 min, the rest 15 min.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV36(db: Database): void {
  if (!addColumnIfMissing(db, 'central_assignment', 'lease_until', 'INTEGER')) return
  db.exec(`UPDATE central_assignment SET lease_until = COALESCE(last_signal_at, started_at) + (
      SELECT CASE t.status WHEN 'assigned' THEN 60000 WHEN 'running' THEN 360000 WHEN 'reported' THEN 600000 WHEN 'verifying' THEN 600000 ELSE 900000 END
      FROM central_task t WHERE t.id = central_assignment.task_id)
    WHERE ended_at IS NULL`)
}
