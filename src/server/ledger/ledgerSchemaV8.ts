/**
 * CA2 v8 `ca2_checkpoint` (RND/29-CA2-ARSITEKTUR-b.md 4.6): conversation checkpoints plus the
 * last-step context size on `central_turn`. No FK to central_conversation (standalone ledger).
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

/** Maximum characters of the checkpoint narrative. */
export const CHECKPOINT_NARRATIVE_MAX = 1500

/** Idempotent table DDL. */
export const DDL_V8 = `
CREATE TABLE IF NOT EXISTS central_checkpoint (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
  from_message_id TEXT, to_message_id TEXT,
  schema_v INTEGER NOT NULL DEFAULT 1,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  narrative TEXT NOT NULL CHECK (length(narrative) <= ${CHECKPOINT_NARRATIVE_MAX}),
  model TEXT, usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  source TEXT NOT NULL CHECK (source IN ('auto','manual','fallback')),
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
`

/** Applies v8; the ALTER is guarded so a re-run after a partial apply is safe. */
export function applyV8(db: Database): void {
  db.exec(DDL_V8)
  addColumnIfMissing(db, 'central_turn', 'ctx_tokens', 'INTEGER')
}
