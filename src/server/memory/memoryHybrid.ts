/**
 * Hybrid retrieval over the v7 memory table (RND/24 3.4): unicode61 FTS (AND first, OR when
 * thin) plus trigram FTS, fused with RRF and re-ranked. Read-only apart from `touchMemoryUse`.
 * Visibility is decided here, in SQL, from the viewer's project: callers cannot widen it.
 */
import type { Database } from 'bun:sqlite'
import { allRows, getRow, stmt } from '../ledger/ledgerCore'
import { toMemory } from './memoryCore'
import { rankScore, rrfFuse } from './memoryRrf'
import type { MemoryAnyScope, MemoryKind, MemoryRecord, MemoryTrust } from './memoryModel'

/** Candidates pulled from each FTS index before fusion. */
export const CANDIDATES_PER_INDEX = 30
/** Below this many AND-matches the unicode61 leg is widened to OR. */
const MIN_AND_HITS = 3
const MAX_QUERY_TOKENS = 12
const MAX_TOKEN_CHARS = 64
const TRIGRAM_MIN_CHARS = 3
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 30

/** Who is asking: `projectId` null = the global central conversation. */
export interface MemoryViewer {
  projectId: string | null
}

export interface HybridSearchOptions {
  viewer: MemoryViewer
  query: string
  now: number
  limit?: number
  scope?: MemoryAnyScope
  kind?: MemoryKind
}

export interface MemoryRankedHit {
  record: MemoryRecord
  score: number
  /** `stale_after` has passed: still shown, ranked down, flagged for re-verification. */
  stale: boolean
  /** An agent claim (scope central), not a verified fact. */
  unverified: boolean
}

/** Maps a raw row (with v7 columns) to a record. */
export function toMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    ...toMemory(row),
    kind: String(row['kind']) as MemoryKind,
    trust: String(row['trust']) as MemoryTrust,
    staleAfter: row['stale_after'] === null ? null : Number(row['stale_after']),
    useCount: Number(row['use_count'] ?? 0),
    contentHash: row['content_hash'] === null || row['content_hash'] === undefined ? null : String(row['content_hash']),
  }
}

/**
 * What a viewer may read. Facts of `user`/`global` (never project-bound), central claims or facts
 * of the viewer's project or the global conversation, and the viewer's own project facts.
 * `external` trust is never served, and superseded rows are gone.
 */
function visibility(viewer: MemoryViewer, now: number): { sql: string; params: unknown[] } {
  const clauses = ["(m.scope IN ('user','global') AND m.project_id IS NULL AND m.status = 'fact')"]
  const params: unknown[] = []
  if (viewer.projectId === null) {
    clauses.push("(m.scope = 'central' AND m.project_id IS NULL AND m.status IN ('claim','fact'))")
  } else {
    clauses.push("(m.scope = 'central' AND (m.project_id IS NULL OR m.project_id = ?) AND m.status IN ('claim','fact'))")
    clauses.push("(m.scope IN ('project','core','scratch') AND m.project_id = ? AND m.status = 'fact')")
    params.push(viewer.projectId, viewer.projectId)
  }
  // An expired claim is dropped; an expired fact stays (flagged stale) because facts are never auto-deleted.
  const sql = `(${clauses.join(' OR ')}) AND m.superseded_at IS NULL AND m.trust != 'external'
    AND (m.status = 'fact' OR m.stale_after IS NULL OR m.stale_after > ?)`
  return { sql, params: [...params, now] }
}

function tokensOf(query: string): string[] {
  if (typeof query !== 'string') return []
  return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, MAX_QUERY_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_CHARS).replace(/"/g, '""'))
}

const matchExpr = (tokens: string[], joiner: 'AND' | 'OR'): string => tokens.map((t) => `"${t}"`).join(` ${joiner} `)

interface Leg { table: 'memory_fts' | 'memory_fts_tri'; match: string }

function runLeg(db: Database, leg: Leg, vis: ReturnType<typeof visibility>, filter: string, filterParams: unknown[]): Record<string, unknown>[] {
  // `leg.table` is one of two constants, never caller input.
  return allRows(
    db,
    `SELECT m.* FROM ${leg.table} JOIN memory m ON m.rowid = ${leg.table}.rowid
     WHERE ${leg.table} MATCH ? AND ${vis.sql}${filter}
     ORDER BY bm25(${leg.table}) ASC, m.id ASC LIMIT ?`,
    leg.match, ...vis.params, ...filterParams, CANDIDATES_PER_INDEX
  )
}

/** Ranked, visible memories for a query; empty when nothing searchable remains. */
export function searchMemoryHybrid(db: Database, opts: HybridSearchOptions): MemoryRankedHit[] {
  const tokens = tokensOf(opts.query)
  if (tokens.length === 0) return []
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
  const vis = visibility(opts.viewer, opts.now)
  const filterParts: string[] = []
  const filterParams: unknown[] = []
  if (opts.scope !== undefined) { filterParts.push(' AND m.scope = ?'); filterParams.push(opts.scope) }
  if (opts.kind !== undefined) { filterParts.push(' AND m.kind = ?'); filterParams.push(opts.kind) }
  const filter = filterParts.join('')

  let lexical = runLeg(db, { table: 'memory_fts', match: matchExpr(tokens, 'AND') }, vis, filter, filterParams)
  if (lexical.length < MIN_AND_HITS && tokens.length > 1) {
    lexical = runLeg(db, { table: 'memory_fts', match: matchExpr(tokens, 'OR') }, vis, filter, filterParams)
  }
  const long = tokens.filter((token) => token.length >= TRIGRAM_MIN_CHARS)
  const trigram = long.length === 0 ? [] : runLeg(db, { table: 'memory_fts_tri', match: matchExpr(long, 'OR') }, vis, filter, filterParams)
  // TODO(ca2-08): third RRF leg from memory_embedding when WEBTERM_EMBED_URL is set; lexical-only until an embed client lands.

  const byId = new Map<string, MemoryRecord>()
  for (const row of [...lexical, ...trigram]) if (!byId.has(String(row['id']))) byId.set(String(row['id']), toMemoryRecord(row))
  const lists = [lexical, trigram].filter((rows) => rows.length > 0)
  const fused = rrfFuse(lists.map((rows) => rows.map((row) => String(row['id']))))
  const hits = [...byId.values()].map((record): MemoryRankedHit => {
    const stale = record.staleAfter !== null && record.staleAfter <= opts.now
    const score = rankScore({
      rrf: fused.get(record.id) ?? 0, lists: lists.length, updatedAt: record.updatedAt,
      now: opts.now, kind: record.kind, scope: record.scope, stale,
    })
    return { record, score, stale, unverified: record.status === 'claim' }
  })
  hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
  return hits.slice(0, limit)
}

/** One memory by id, only when the viewer may see it (same rules as search). */
export function getVisibleMemory(db: Database, viewer: MemoryViewer, id: string, now: number): MemoryRecord | null {
  const vis = visibility(viewer, now)
  const row = getRow(db, `SELECT m.* FROM memory m WHERE m.id = ? AND ${vis.sql}`, id, ...vis.params)
  return row === null ? null : toMemoryRecord(row)
}

/** Batch usage bookkeeping for the ids that went into a prompt (one statement, not per read). */
export function touchMemoryUse(db: Database, ids: readonly string[], now: number): void {
  if (ids.length === 0) return
  const marks = ids.map(() => '?').join(',')
  stmt(db, `UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${marks})`).run(now, ...ids)
}
