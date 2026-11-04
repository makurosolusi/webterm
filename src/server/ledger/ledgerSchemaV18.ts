/**
 * v18 memory intelligence (PLAN/02-fase.md F5-a, PLAN/rnd/03-memory-context-cache.md §1.2, §5).
 *
 * Imitated designs:
 * - Graphiti/Zep bi-temporal facts (arXiv 2501.13956): a fact is invalidated, never deleted. `valid_from`
 *   / `valid_to` bound when it held, `superseded_by` points at the replacement, `source_event_id` traces
 *   it to the Senses event (F1-c) it came from.
 * - ChatGPT memory controls: "forget" leaves a `memory_tombstone` (normalized text hash + subject) so a
 *   later consolidation or import from an old transcript cannot bring it back; "don't mention again"
 *   sets `suppressed_at` (kept, not served); `memory_incognito` lists sessions nothing is stored from.
 *
 * `cognitive_kind` is a VIRTUAL generated column over the v7 `kind` (semantic | episodic | procedural),
 * so the existing CHECK on `kind` and every writer stay as they are. `PRAGMA table_info` hides
 * generated columns, hence the `table_xinfo` guard instead of `addColumnIfMissing`.
 *
 * Re-run safe: guarded ALTERs, IF NOT EXISTS, and backfills that only touch NULL columns.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export const COGNITIVE_KIND_SQL =
  "CASE kind WHEN 'procedure' THEN 'procedural' WHEN 'episode' THEN 'episodic' WHEN 'summary' THEN 'episodic' ELSE 'semantic' END"

export const DDL_V18 = `
CREATE TABLE IF NOT EXISTS memory_tombstone (
  text_hash  TEXT NOT NULL,
  -- project id of the forgotten row, '' for user/global/central-global memory (blocks it everywhere).
  subject    TEXT NOT NULL,
  memory_id  TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (text_hash, subject)
);

CREATE TABLE IF NOT EXISTS memory_incognito (
  ref        TEXT PRIMARY KEY,
  set_by     TEXT NOT NULL,
  since      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_cognitive ON memory(cognitive_kind, status);
`

/** Existing rows: valid since creation; superseded rows closed at superseded_at and linked forward. */
const BACKFILL = `
UPDATE memory SET valid_from = created_at WHERE valid_from IS NULL;
UPDATE memory SET valid_to = superseded_at WHERE valid_to IS NULL AND superseded_at IS NOT NULL;
UPDATE memory SET superseded_by = (SELECT n.id FROM memory n WHERE n.supersedes = memory.id ORDER BY n.created_at LIMIT 1)
  WHERE superseded_by IS NULL AND status = 'superseded';
`

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_xinfo(${table})`).all() as { name?: unknown }[]).some((c) => c.name === column)
}

export function applyV18(db: Database): void {
  addColumnIfMissing(db, 'memory', 'valid_from', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'valid_to', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'superseded_by', 'TEXT')
  addColumnIfMissing(db, 'memory', 'source_event_id', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'suppressed_at', 'INTEGER')
  if (!hasColumn(db, 'memory', 'cognitive_kind')) {
    db.exec(`ALTER TABLE memory ADD COLUMN cognitive_kind TEXT GENERATED ALWAYS AS (${COGNITIVE_KIND_SQL}) VIRTUAL`)
  }
  db.exec(BACKFILL)
  db.exec(DDL_V18)
}
