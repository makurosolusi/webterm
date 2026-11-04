/**
 * v10 `senses_event_log` (PLAN/01-arsitektur.md S3, K9): turns `event` into the tamper-evident
 * Senses log. Adds the producer columns and the append-only triggers that close TODO(ca2-audit).
 *
 * Why the triggers are scoped to `hash IS NOT NULL` (chained rows): v1's legacy audit rows carry
 * `project_id ... ON DELETE CASCADE` / `task_id, run_id ... ON DELETE SET NULL`, so
 * `Ledger.deleteProject` turns into DELETE/UPDATE on `event`. Chained rows never set those FKs
 * (enforced by `event_chain_no_fk` below), so a cascade can never reach them, and the legacy
 * per-project audit trail keeps its delete-with-project behaviour unchanged.
 *
 * Same-uid limit (stated honestly, Engineer §2.3): any process with this uid can DROP these
 * triggers or rewrite the file. The triggers stop accidental/buggy writers; the hash chain plus
 * the external anchor (src/server/events/eventAnchor.ts) make tampering detectable, not impossible.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

/** Idempotent index + trigger DDL (all IF NOT EXISTS). */
export const DDL_V10 = `
CREATE INDEX IF NOT EXISTS idx_event_dedupe ON event(dedupe_key, ts) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_kind_seq ON event(kind, seq);

CREATE TRIGGER IF NOT EXISTS event_chain_no_update BEFORE UPDATE ON event
WHEN OLD.hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TRIGGER IF NOT EXISTS event_chain_no_delete BEFORE DELETE ON event
WHEN OLD.hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TRIGGER IF NOT EXISTS event_chain_no_fk BEFORE INSERT ON event
WHEN NEW.hash IS NOT NULL AND (NEW.project_id IS NOT NULL OR NEW.task_id IS NOT NULL OR NEW.run_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'chained event must not reference project/task/run'); END;
`

/** Applies v10; every ALTER is guarded so a re-run after a partial apply is safe. Legacy rows stay NULL. */
export function applyV10(db: Database): void {
  addColumnIfMissing(db, 'event', 'source', 'TEXT')
  addColumnIfMissing(db, 'event', 'subject', 'TEXT')
  addColumnIfMissing(db, 'event', 'workspace_id', 'TEXT')
  addColumnIfMissing(db, 'event', 'node_id', 'TEXT')
  addColumnIfMissing(db, 'event', 'trust', "TEXT CHECK (trust IS NULL OR trust IN ('trusted','untrusted'))")
  addColumnIfMissing(db, 'event', 'dedupe_key', 'TEXT')
  db.exec(DDL_V10)
}
