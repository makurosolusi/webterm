/**
 * State-first inbox projection over the ledger (RND/02-KEBUTUHAN.md U1, U6).
 *
 * The projection is intentionally one UNION ALL query so category rank, age,
 * and pagination are resolved by SQLite in a single stable order. Nothing here
 * writes: `buildInbox` performs SELECTs only, so rendering the inbox can never
 * approve, retry, or otherwise act on the user's behalf.
 */
import type { Database } from 'bun:sqlite'
import { allRows } from '../ledger/ledgerCore'
import {
  type InboxCategory,
  type InboxCounts,
  InboxError,
  type InboxItem,
  type InboxKind,
  type InboxOptions,
  type InboxResult,
} from './inboxModel'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const TITLE_MAX = 120
const SUMMARY_MAX = 160

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new InboxError(`buildInbox: limit must be a positive number, got ${String(limit)}`)
  }
  return Math.min(MAX_LIMIT, Math.trunc(limit))
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    throw new InboxError(`buildInbox: offset must be a finite number, got ${String(offset)}`)
  }
  return Math.max(0, Math.trunc(offset))
}

function normalizeProject(projectId: string | undefined): string | undefined {
  if (projectId === undefined) return undefined
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new InboxError('buildInbox: projectId must be a non-empty string when provided')
  }
  return projectId
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function summarize(value: unknown): string | null {
  if (value === null || value === undefined) return null
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? null : oneLine(flat, SUMMARY_MAX)
}

interface ItemRow {
  category: string
  kind: string
  id: string
  project_id: string | null
  project_name: string | null
  label: string | null
  spec: string | null
  payload: string | null
  status: string
  created_at: number
  fence: number | null
}

/**
 * All inbox states in one SQL text. Categories:
 * - needs_you: pending approvals (expired ones excluded) + blocked tasks;
 * - review: `claimed_done` and `suspect` tasks waiting for a human verdict;
 * - broken: `failed`/`cancelled` tasks + live-status leases already past expiry
 *   (failed reaper, so the projection stays truthful even before the sweep).
 */
function unionSql(now: number, projectId: string | undefined): { sql: string; params: unknown[] } {
  const filter = (alias: string) => (projectId === undefined ? '' : ` AND ${alias}.project_id = ?`)
  const extra = projectId === undefined ? [] : [projectId]
  const branches = [
    {
      params: [now, ...extra],
      sql: `SELECT 'needs_you' AS category, 'approval' AS kind, a.id AS id,
              a.project_id AS project_id, p.name AS project_name, a.kind AS label,
              NULL AS spec, a.request_json AS payload, a.status AS status,
              a.created_at AS created_at, NULL AS fence
            FROM approval a LEFT JOIN project p ON p.id = a.project_id
            WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)${filter('a')}`,
    },
    {
      params: extra,
      sql: `SELECT 'needs_you', 'task', t.id, t.project_id, p.name, NULL, t.spec,
              t.evidence_json, t.status, t.created_at, t.fence
            FROM task t LEFT JOIN project p ON p.id = t.project_id
            WHERE t.status = 'blocked'${filter('t')}`,
    },
    {
      params: extra,
      sql: `SELECT 'review', 'task', t.id, t.project_id, p.name, NULL, t.spec,
              t.evidence_json, t.status, t.created_at, t.fence
            FROM task t LEFT JOIN project p ON p.id = t.project_id
            WHERE t.status IN ('claimed_done', 'suspect')${filter('t')}`,
    },
    {
      params: extra,
      sql: `SELECT 'broken', 'task', t.id, t.project_id, p.name, NULL, t.spec,
              t.evidence_json, t.status, t.created_at, t.fence
            FROM task t LEFT JOIN project p ON p.id = t.project_id
            WHERE t.status IN ('failed', 'cancelled')${filter('t')}`,
    },
    {
      params: [now, ...extra],
      sql: `SELECT 'broken', 'lease', t.id, t.project_id, p.name, NULL, t.spec,
              t.evidence_json, t.status, t.created_at, t.fence
            FROM task t LEFT JOIN project p ON p.id = t.project_id
            WHERE t.status = 'leased' AND t.lease_expires IS NOT NULL
              AND t.lease_expires <= ?${filter('t')}`,
    },
  ]
  return {
    sql: branches.map((branch) => branch.sql).join('\nUNION ALL\n'),
    params: branches.flatMap((branch) => branch.params),
  }
}

function toItem(row: ItemRow, now: number): InboxItem {
  const kind = row.kind as InboxKind
  const isApproval = kind === 'approval'
  const title = isApproval
    ? `Approval: ${row.label ?? 'request'}`
    : oneLine(row.spec ?? `Task ${row.id}`, TITLE_MAX)
  const created = Number(row.created_at)
  return {
    id: String(row.id),
    category: row.category as InboxCategory,
    kind,
    projectId: row.project_id === null ? null : String(row.project_id),
    projectName: row.project_name === null ? null : String(row.project_name),
    title,
    ageMs: Math.max(0, now - created),
    createdAt: created,
    status: String(row.status),
    evidenceSummary: summarize(row.payload) ?? (isApproval ? null : 'no evidence'),
    ...(row.fence === null || row.fence === undefined ? {} : { fence: Number(row.fence) }),
  }
}

/**
 * Builds one page of the inbox. `projectId` omitted means the cross-project view
 * (U6); the project is a facet on each item, not a separate tab.
 *
 * Ordering is stable and deterministic: category rank (needs_you, review,
 * broken), then oldest `created_at` first, then kind and id.
 */
export function buildInbox(
  db: Database,
  projectId?: string,
  opts: InboxOptions = {}
): InboxResult {
  const project = normalizeProject(projectId)
  const now = opts.now ?? Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new InboxError(`buildInbox: now must be epoch-ms, got ${String(now)}`)
  }
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const union = unionSql(now, project)
  const rows = allRows(
    db,
    `SELECT * FROM (${union.sql}) AS items
     ORDER BY CASE category WHEN 'needs_you' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
              created_at ASC, kind ASC, id ASC
     LIMIT ? OFFSET ?`,
    ...union.params,
    limit,
    offset
  ) as unknown as ItemRow[]
  return {
    items: rows.map((row) => toItem(row, now)),
    total: countTotal(db, now, project),
    limit,
    offset,
  }
}

function countTotal(db: Database, now: number, projectId: string | undefined): number {
  const union = unionSql(now, projectId)
  const rows = allRows(
    db,
    `SELECT COUNT(*) AS n FROM (${union.sql}) AS items`,
    ...union.params
  )
  return rows.length === 0 ? 0 : Number(rows[0]?.['n'] ?? 0)
}

/** Per-category counts for badges; same projection, no pagination. */
export function inboxCounts(
  db: Database,
  projectId?: string,
  opts: InboxOptions = {}
): InboxCounts {
  const project = normalizeProject(projectId)
  const now = opts.now ?? Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new InboxError(`inboxCounts: now must be epoch-ms, got ${String(now)}`)
  }
  const union = unionSql(now, project)
  const rows = allRows(
    db,
    `SELECT category, COUNT(*) AS n FROM (${union.sql}) AS items GROUP BY category`,
    ...union.params
  )
  const counts: InboxCounts = { needsYou: 0, review: 0, broken: 0, total: 0 }
  for (const row of rows) {
    const n = Number(row['n'] ?? 0)
    const category = String(row['category'])
    if (category === 'needs_you') counts.needsYou = n
    else if (category === 'review') counts.review = n
    else if (category === 'broken') counts.broken = n
    counts.total += n
  }
  return counts
}
