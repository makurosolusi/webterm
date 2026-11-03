// knowledge.db: a separate, disposable SQLite cache derived from project files (RND/27 4.2).
// It is never authoritative: a schema change drops and rebuilds it, no migration or backup.
import { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow } from '../ledger/ledgerCore'

/** Bump to make every existing knowledge.db rebuild from scratch. */
export const KB_SCHEMA_VERSION = 1
/** Above this many files an index is `light`: paths only, no content reads, no import graph. */
export const KB_MAX_FILES = 20_000
/** Files larger than this are listed but never read. */
export const KB_MAX_FILE_BYTES = 512 * 1024
/** Doc files (README, CLAUDE.md, ...) are cut at this size before sectioning. */
export const KB_MAX_DOC_BYTES = 64 * 1024
/** The scan yields to the event loop after this many files. */
export const KB_YIELD_EVERY = 200
/** Index level: `full` has the import graph, `light` is paths only. */
export type KbLevel = 'full' | 'light'

/** Coded failure of the knowledge subsystem; callers match `code`, never the message. */
export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export interface KbProjectRow {
  projectId: string
  root: string
  headSha: string | null
  dirtyHash: string
  commitTs: number | null
  indexedAt: number
  level: KbLevel
  fileCount: number
}

const TABLES = ['kb_meta', 'kb_project', 'project_source', 'kb_file', 'kb_doc'] as const
const DDL = `
CREATE TABLE IF NOT EXISTS kb_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kb_project (
  project_id TEXT PRIMARY KEY, root TEXT NOT NULL, head_sha TEXT, dirty_hash TEXT NOT NULL,
  commit_ts INTEGER, indexed_at INTEGER NOT NULL, level TEXT NOT NULL, file_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_source (
  project_id TEXT PRIMARY KEY, root_abs TEXT NOT NULL, kind TEXT NOT NULL, added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_file (
  project_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL, bytes INTEGER NOT NULL, lang TEXT NOT NULL,
  exports_json TEXT NOT NULL DEFAULT '[]', imports_json TEXT NOT NULL DEFAULT '[]', in_degree INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_doc USING fts5(project_id UNINDEXED, path, heading, text);
`

/** Opens (creating or rebuilding) the knowledge cache at `file`; `:memory:` works for tests. */
export function openKnowledgeDb(file: string): Database {
  const db = new Database(file)
  const version = Number(getRow(db, 'PRAGMA user_version')?.user_version ?? 0)
  if (version !== 0 && version !== KB_SCHEMA_VERSION) for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
  db.exec(DDL)
  db.exec(`PRAGMA user_version = ${KB_SCHEMA_VERSION}`)
  return db
}

/** Runs `fn` inside one transaction; rolls back and rethrows with context on failure. */
export function inTransaction<T>(db: Database, label: string, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw new KnowledgeError('kb_write_failed', `knowledge ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The stored index state of a project, or null when it was never indexed. */
export function getKbProject(db: Database, projectId: string): KbProjectRow | null {
  const r = getRow(db, 'SELECT * FROM kb_project WHERE project_id = ?', projectId)
  if (!r) return null
  return {
    projectId, root: String(r.root), headSha: r.head_sha === null ? null : String(r.head_sha), dirtyHash: String(r.dirty_hash),
    commitTs: r.commit_ts === null ? null : Number(r.commit_ts), indexedAt: Number(r.indexed_at),
    level: r.level === 'light' ? 'light' : 'full', fileCount: Number(r.file_count),
  }
}

/** Inserts or replaces the index state of a project. */
export function putKbProject(db: Database, row: KbProjectRow, kind: 'git' | 'dir'): void {
  execWrite(db, 'INSERT OR REPLACE INTO kb_project (project_id, root, head_sha, dirty_hash, commit_ts, indexed_at, level, file_count) VALUES (?,?,?,?,?,?,?,?)',
    row.projectId, row.root, row.headSha, row.dirtyHash, row.commitTs, row.indexedAt, row.level, row.fileCount)
  execWrite(db, 'INSERT OR REPLACE INTO project_source (project_id, root_abs, kind, added_by) VALUES (?,?,?,?)', row.projectId, row.root, kind, 'knowledge')
}

/** Stored path -> blob sha for one project (drives incremental rescans). */
export function storedShas(db: Database, projectId: string): Map<string, { sha: string; exports: string; imports: string; bytes: number; lang: string }> {
  const out = new Map<string, { sha: string; exports: string; imports: string; bytes: number; lang: string }>()
  for (const r of allRows(db, 'SELECT path, sha, bytes, lang, exports_json, imports_json FROM kb_file WHERE project_id = ?', projectId)) {
    out.set(String(r.path), { sha: String(r.sha), exports: String(r.exports_json), imports: String(r.imports_json), bytes: Number(r.bytes), lang: String(r.lang) })
  }
  return out
}
