/**
 * CA2 v7 `ca2_memory` (RND/29-CA2-ARSITEKTUR-b.md 4.6, 4.9): typed/trusted memory, a trigram
 * FTS index, and an embedding side table. v1 `UNIQUE (project_id, scope, key)` never
 * constrained rows whose project_id is NULL (NULLs compare distinct), so legacy duplicates
 * may exist: they are deduped BEFORE `uq_memory_key` is created.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

const DEDUPE_SUFFIX = '#superseded-'

/**
 * Per (scope,key) with NULL project_id keep the newest row (updated_at, created_at, rowid) and
 * mark the rest `superseded`. Their key is suffixed with the id because uq_memory_key covers
 * every status, and the suffix keeps the old content addressable for audit.
 */
export const DEDUPE_NULL_PROJECT = `
UPDATE memory
SET status = 'superseded',
    superseded_at = COALESCE(superseded_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
    key = key || '${DEDUPE_SUFFIX}' || id
WHERE project_id IS NULL AND status != 'superseded' AND EXISTS (
  SELECT 1 FROM memory newer
  WHERE newer.project_id IS NULL AND newer.scope = memory.scope AND newer.key = memory.key
    AND newer.id != memory.id AND newer.status != 'superseded'
    AND (newer.updated_at, newer.created_at, newer.rowid) > (memory.updated_at, memory.created_at, memory.rowid)
);
`

/** Same-key rows already `superseded` with NULL project: free the key as well. */
const DEDUPE_ALREADY_SUPERSEDED = `
UPDATE memory SET key = key || '${DEDUPE_SUFFIX}' || id
WHERE project_id IS NULL AND status = 'superseded' AND key NOT LIKE '%${DEDUPE_SUFFIX}%' AND EXISTS (
  SELECT 1 FROM memory o WHERE o.project_id IS NULL AND o.scope = memory.scope AND o.key = memory.key AND o.id != memory.id
);
`

/** Idempotent tables, unique index, trigram FTS and its sync triggers. */
export const DDL_V7 = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_key ON memory(COALESCE(project_id, ''), scope, key);

CREATE TABLE IF NOT EXISTS memory_embedding (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, dim INTEGER NOT NULL CHECK (dim > 0),
  content_hash TEXT NOT NULL, vec BLOB NOT NULL,
  PRIMARY KEY (memory_id, model_id)
);

-- Rebuildable like memory_fts: content is served from memory.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(
  title, body, content='memory', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_tri_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts_tri(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_tri_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts_tri(memory_fts_tri, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_tri_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts_tri(memory_fts_tri, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_fts_tri(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

INSERT INTO memory_fts_tri(memory_fts_tri) VALUES ('rebuild');
`

/** Applies v7; guarded ALTERs and the one-time trust backfill make a re-run safe. */
export function applyV7(db: Database): void {
  db.exec(DEDUPE_NULL_PROJECT)
  db.exec(DEDUPE_ALREADY_SUPERSEDED)
  addColumnIfMissing(
    db, 'memory', 'kind',
    "TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','preference','decision','procedure','episode','summary'))"
  )
  const trustAdded = addColumnIfMissing(
    db, 'memory', 'trust',
    "TEXT NOT NULL DEFAULT 'agent' CHECK (trust IN ('human','attested','agent','external'))"
  )
  addColumnIfMissing(db, 'memory', 'content_hash', 'TEXT')
  addColumnIfMissing(db, 'memory', 'stale_after', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'verified_at', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'last_used_at', 'INTEGER')
  addColumnIfMissing(db, 'memory', 'use_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'memory', 'links_json', 'TEXT CHECK (links_json IS NULL OR json_valid(links_json))')
  // Only on the first run: legacy human-promoted facts keep their authority; later rows must not be re-trusted.
  if (trustAdded) db.exec("UPDATE memory SET trust = 'human' WHERE status = 'fact'")
  db.exec(DDL_V7)
}
