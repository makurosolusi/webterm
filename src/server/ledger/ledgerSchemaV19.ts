/**
 * v19 deterministic caches (PLAN/02-fase.md F5-d, PLAN/rnd/03-memory-context-cache.md §3).
 *
 * - `tool_cache`: result of an idempotent R0 read keyed by (tool, normalised args). A row is only served
 *   while `version` (git HEAD + working-tree status of the source) still matches; LRU by `last_used_at`.
 * - `embed_cache`: vector keyed by sha256(model id + normalised text), so the same text is never embedded
 *   twice for the same model. Embeddings are for memory/conversation text only, never code.
 * - `prefix.last_used_at`: when a recorded Central prompt prefix was last reused (v1 has `hits` only).
 *
 * Additive and re-run safe: IF NOT EXISTS plus a guarded ALTER; nothing to backfill (caches start empty).
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export const DDL_V19 = `
CREATE TABLE IF NOT EXISTS tool_cache (
  key          TEXT PRIMARY KEY,
  tool         TEXT NOT NULL,
  version      TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_cache_lru ON tool_cache(last_used_at);

CREATE TABLE IF NOT EXISTS embed_cache (
  key          TEXT PRIMARY KEY,
  model_id     TEXT NOT NULL,
  dim          INTEGER NOT NULL CHECK (dim > 0),
  vec          BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embed_cache_lru ON embed_cache(last_used_at);
`

export function applyV19(db: Database): void {
  db.exec(DDL_V19)
  addColumnIfMissing(db, 'prefix', 'last_used_at', 'INTEGER')
}
