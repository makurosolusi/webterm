/**
 * Row-level SQL for central/user memories (v7 columns). `uq_memory_key` is
 * `(COALESCE(project_id,''), scope, key)`, so lookups here use the same COALESCE: a plain
 * `project_id = ?` would never match a NULL-project row (bug B5).
 */
import type { Database } from 'bun:sqlite'
import { execInsert, execWrite, getRow } from '../ledger/ledgerCore'
import { toMemoryRecord } from './memoryHybrid'
import { MemoryConflictError, type MemoryAnyScope, type MemoryKind, type MemoryRecord, type MemoryTrust } from './memoryModel'

export interface NewMemoryRow {
  id: string
  projectId: string | null
  scope: MemoryAnyScope
  key: string
  title: string
  body: string
  status: 'claim' | 'fact'
  kind: MemoryKind
  trust: MemoryTrust
  sourceKind: string
  sourceRef: string
  supersedes: string | null
  contentHash: string
  staleAfter: number | null
  verifiedAt: number | null
  now: number
}

/** The row holding `(project, scope, key)` in any status, or null. */
export function findRowByKey(db: Database, projectId: string | null, scope: MemoryAnyScope, key: string): MemoryRecord | null {
  const row = getRow(db, "SELECT * FROM memory WHERE COALESCE(project_id, '') = ? AND scope = ? AND key = ?", projectId ?? '', scope, key)
  return row === null ? null : toMemoryRecord(row)
}

/** An active (claim/fact, not superseded) row with the same content hash in the same slot. */
export function findActiveByHash(db: Database, projectId: string | null, scope: MemoryAnyScope, hash: string): MemoryRecord | null {
  const row = getRow(
    db,
    `SELECT * FROM memory WHERE COALESCE(project_id, '') = ? AND scope = ? AND content_hash = ?
       AND status IN ('claim','fact') AND superseded_at IS NULL LIMIT 1`,
    projectId ?? '', scope, hash
  )
  return row === null ? null : toMemoryRecord(row)
}

/** Inserts one v7 row; a unique-index hit becomes a typed conflict. */
export function insertMemoryRow(db: Database, row: NewMemoryRow): void {
  try {
    execInsert(
      db,
      `INSERT INTO memory (id, project_id, scope, key, title, body, status, source_kind, source_ref, supersedes,
         created_at, updated_at, kind, trust, content_hash, stale_after, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.projectId, row.scope, row.key, row.title, row.body, row.status, row.sourceKind, row.sourceRef,
      row.supersedes, row.now, row.now, row.kind, row.trust, row.contentHash, row.staleAfter, row.verifiedAt
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE')) {
      throw new MemoryConflictError(`memory ${row.scope}/${row.key} already exists`, { cause: err })
    }
    throw err
  }
}

/** Retires a row into history and frees its key for the replacement. */
export function supersedeRow(db: Database, old: MemoryRecord, now: number): void {
  execWrite(
    db,
    "UPDATE memory SET status = 'superseded', superseded_at = ?, updated_at = ?, key = ? WHERE id = ?",
    now, now, `${old.key}#superseded:${old.id}`, old.id
  )
}
