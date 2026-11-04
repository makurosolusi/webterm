/**
 * CA2 v9 `ca2_audit_chain` (RND/29-CA2-ARSITEKTUR-b.md 4.6): hash-chain columns on `event`.
 * Only the additive, nullable columns are applied (legacy rows stay NULL).
 *
 * The append-only trigger is NOT registered here: `Ledger.deleteProject` cascades DELETE/UPDATE
 * into legacy `event` rows (v1 FKs), which an unconditional trigger would abort. v10
 * (`ledgerSchemaV10.ts`) registers it scoped to chained rows (`hash IS NOT NULL`, no FKs), which
 * closes the former TODO(ca2-audit).
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

/** Unscoped append-only guard (v10 registers the chained-row-scoped one); exercised by migrationCa2 tests. */
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
