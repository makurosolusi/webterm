/**
 * Read paths: FTS5 search (bm25 ranked), plain listing for history, and the
 * per-row audit trail. Search is read-only and never mutates a row, so a stale
 * fact stays visible with its provenance instead of being hidden (M10).
 */
import type { Database } from 'bun:sqlite'
import { allRows, requireText } from '../ledger/ledgerCore'
import {
  clampLimit,
  clampOffset,
  memoryContext,
  memoryEventsOf,
  toMemory,
  toFtsQuery,
} from './memoryCore'
import {
  type ListMemoryOptions,
  type Memory,
  type MemoryEvent,
  type MemoryEventsOptions,
  type MemorySearchHit,
} from './memoryModel'

/**
 * `MATCH` over title+body inside one project, `status='fact'` only and never a
 * superseded row (`superseded_at IS NULL`). `ORDER BY bm25` puts the best match
 * first; ties break newest-updated first so paging is deterministic.
 */
export function searchMemory(
  db: Database,
  projectId: string,
  query: string,
  limit = 20
): MemorySearchHit[] {
  const project = requireText(projectId, 'searchMemory.projectId')
  const fts = toFtsQuery(query)
  if (fts === null) return []
  const capped = clampLimit(limit)
  const rows = allRows(
    db,
    `SELECT m.*, bm25(memory_fts) AS rank
     FROM memory_fts
     JOIN memory m ON m.rowid = memory_fts.rowid
     WHERE memory_fts MATCH ?
       AND m.project_id = ?
       AND m.status = 'fact'
       AND m.superseded_at IS NULL
     ORDER BY rank ASC, m.updated_at DESC, m.id ASC
     LIMIT ?`,
    fts,
    project,
    capped
  )
  return rows.map((row) => ({ ...toMemory(row), rank: Number(row['rank']) }))
}

/**
 * Raw listing, including `superseded` history rows. Use this for audits and the
 * memory panel; use `searchMemory` for retrieval.
 */
export function listMemory(
  db: Database,
  projectId: string,
  opts: ListMemoryOptions = {}
): Memory[] {
  const project = requireText(projectId, 'listMemory.projectId')
  const where = ['project_id = ?']
  const params: unknown[] = [project]
  if (opts.status !== undefined) {
    where.push('status = ?')
    params.push(opts.status)
  }
  if (opts.scope !== undefined) {
    where.push('scope = ?')
    params.push(opts.scope)
  }
  params.push(clampLimit(opts.limit, 200), clampOffset(opts.offset))
  return allRows(
    db,
    `SELECT * FROM memory WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
    ...params
  ).map(toMemory)
}

/** Audit trail for one memory row, oldest event first. */
export function memoryEvents(
  db: Database,
  memoryId: string,
  opts: MemoryEventsOptions = {}
): MemoryEvent[] {
  const id = requireText(memoryId, 'memoryEvents.memoryId')
  const ctx = memoryContext(db)
  return memoryEventsOf(ctx, id, clampLimit(opts.limit, 200))
}
