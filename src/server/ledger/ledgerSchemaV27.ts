/**
 * v27: Central's pinned STATE documents and the per-turn context trace.
 *
 * `central_state` holds one short document per scope ('global' or 'project:<id>') that Central keeps current
 * and that is injected every turn, so the state of the work survives compaction and session rotation.
 * `central_turn.context_json` records what each turn was given, so "why did Central know this" is answerable.
 * Additive; existing turns keep a NULL trace. Idempotent: IF NOT EXISTS and a guarded ALTER.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export const DDL_V27 = `
CREATE TABLE IF NOT EXISTS central_state (
  scope_key TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK ((scope_key = 'global' AND project_id IS NULL) OR scope_key = 'project:' || project_id)
);
CREATE INDEX IF NOT EXISTS idx_central_state_project ON central_state(project_id);
`

export function applyV27(db: Database): void {
  db.exec(DDL_V27)
  addColumnIfMissing(db, 'central_turn', 'context_json', 'TEXT')
}
