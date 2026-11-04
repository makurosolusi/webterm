/**
 * v21 `eval_case` (PLAN/02-fase.md F6, PLAN/04-buku-ide.md #139/#153): one row per user rejection
 * (approval denied, consolidator proposal dismissed, Central plan rejected, checkpoint rewind), the
 * LangSmith "dataset example from production" shape: input context ref + scrubbed input text, the
 * proposed action, the rejection, an optional user reason. `promoted` rows are what `webterm eval run`
 * replays against Central.
 *
 * - `source_ref` UNIQUE: the ledger row the case was captured from (`approval:<id>`, `event:<seq>`,
 *   `memory_event:<seq>`), so capture is a re-run-safe pull sync and a dismissed case never comes back.
 *
 * Additive only (CREATE ... IF NOT EXISTS), nothing to backfill: history is captured lazily at the
 * first read. v21, not v20: v20 belongs to another F-phase work package landing in parallel.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V21 = `
CREATE TABLE IF NOT EXISTS eval_case (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL CHECK (source IN ('approval', 'central_plan', 'memory_proposal', 'rewind')),
  source_ref     TEXT NOT NULL UNIQUE,
  project_id     TEXT,
  workspace_id   TEXT,
  node_id        TEXT,
  context_ref    TEXT,
  input_text     TEXT,
  proposed_json  TEXT NOT NULL CHECK (json_valid(proposed_json)),
  rejection_json TEXT NOT NULL CHECK (json_valid(rejection_json)),
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'promoted', 'dismissed')),
  rejected_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_case_status ON eval_case(status, rejected_at);
`

export function applyV21(db: Database): void {
  db.exec(DDL_V21)
}
