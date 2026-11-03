/**
 * CA2 v9 `ca2_audit_chain` (RND/29-CA2-ARSITEKTUR-b.md 4.6): hash-chain columns on `event`.
 * Only the additive, nullable columns are applied (legacy rows stay NULL).
 *
 * TODO(ca2-audit): the append-only trigger (`DDL_EVENT_IMMUTABLE`) is NOT registered. The 4.6
 * precondition fails: `Ledger.deleteProject` (ledger.ts) runs `DELETE FROM project`, and v1's
 * `event.project_id ... ON DELETE CASCADE` plus `task_id/run_id ... ON DELETE SET NULL` turn
 * that into DELETE/UPDATE on `event`, which a BEFORE UPDATE/DELETE RAISE(ABORT) trigger would
 * abort (the same applies to plan.bun.test.ts deleting a project). Enable it, in a new
 * migration, only after project deletion archives or detaches events instead of cascading.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

/** Append-only guard for `event`; kept for the future migration, exercised by migrationCa2 tests. */
export const DDL_EVENT_IMMUTABLE = `
CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
`

/** Applies v9 (columns only; see the TODO above). */
export function applyV9(db: Database): void {
  addColumnIfMissing(db, 'event', 'prev_hash', 'TEXT')
  addColumnIfMissing(db, 'event', 'hash', 'TEXT')
}
