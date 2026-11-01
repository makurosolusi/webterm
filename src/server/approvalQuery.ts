// Read-side SQL for the human approval surface. The control plane's `ApprovalLedgerPort` returns
// no digest/nonce and cannot express "approved but not yet consumed", so the human route reads the
// two tables directly. SELECT only: this module never writes.
import type { Database } from 'bun:sqlite'

export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 100

export interface ApprovalChallengeView {
  id: string
  digest: string
  nonce: string
  expiresAt: number | null
  kind: string
  projectId: string | null
  taskId: string | null
  status: string
  consumed: boolean
}

export interface ApprovalListView {
  id: string
  projectId: string | null
  taskId: string | null
  kind: string
  digest: string
  expiresAt: number | null
  createdAt: number
  approvedAt: number
}

export interface ApprovalPage {
  items: ApprovalListView[]
  total: number
  limit: number
  offset: number
}

interface Row {
  [key: string]: unknown
}

const text = (value: unknown): string => String(value)
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)
const nullableInt = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/** Lazy expiry, mirroring `ledgerApproval.effectiveStatus`: a stale `pending` reads as expired. */
function effectiveStatus(status: string, expiresAt: number | null, now: number): string {
  if (status === 'pending' && expiresAt !== null && expiresAt <= now) return 'expired'
  return status
}

/** The challenge row for `id`, or null when it does not exist. */
export function readChallenge(
  db: Database,
  id: string,
  now: number
): ApprovalChallengeView | null {
  const row = db
    .query(
      `SELECT a.id, a.kind, a.project_id, a.task_id, a.status, a.expires_at,
              d.action_digest, d.nonce, d.single_use
       FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`
    )
    .get(id) as Row | null
  if (!row) return null
  const expiresAt = nullableInt(row['expires_at'])
  return {
    id: text(row['id']),
    digest: text(row['action_digest']),
    nonce: text(row['nonce']),
    expiresAt,
    kind: text(row['kind']),
    projectId: nullableText(row['project_id']),
    taskId: nullableText(row['task_id']),
    status: effectiveStatus(text(row['status']), expiresAt, now),
    consumed: Number(row['single_use']) !== 1,
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(limit)))
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  return Math.max(0, Math.trunc(offset))
}

/**
 * Approved-but-unconsumed consent. The panel can lose a decide response (B4), after which the row
 * disappears from the inbox (`pending` only) and there is no other human read path.
 */
export function listApprovedUnconsumed(
  db: Database,
  opts: { projectId?: string; limit?: number; offset?: number; now: number }
): ApprovalPage {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const where = [
    "a.status = 'approved'",
    'd.single_use = 1',
    '(a.expires_at IS NULL OR a.expires_at > ?)',
  ]
  const params: unknown[] = [opts.now]
  if (opts.projectId !== undefined) {
    where.push('a.project_id = ?')
    params.push(opts.projectId)
  }
  const clause = where.join(' AND ')
  const rows = db
    .query(
      `SELECT a.id, a.project_id, a.task_id, a.kind, a.created_at, a.updated_at, a.expires_at,
              d.action_digest
       FROM approval a JOIN decision d ON d.id = a.decision_id
       WHERE ${clause}
       ORDER BY a.created_at ASC, a.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Row[]
  const countRow = db
    .query(
      `SELECT COUNT(*) AS n FROM approval a JOIN decision d ON d.id = a.decision_id
       WHERE ${clause}`
    )
    .get(...params) as Row | null
  return {
    items: rows.map((row) => ({
      id: text(row['id']),
      projectId: nullableText(row['project_id']),
      taskId: nullableText(row['task_id']),
      kind: text(row['kind']),
      digest: text(row['action_digest']),
      expiresAt: nullableInt(row['expires_at']),
      createdAt: Number(row['created_at']),
      approvedAt: Number(row['updated_at']),
    })),
    total: Number(countRow?.['n'] ?? 0),
    limit,
    offset,
  }
}

/** FK-safe request creation: the ledger would otherwise throw a raw constraint error. */
export function projectExists(db: Database, projectId: string): boolean {
  return db.query('SELECT id FROM project WHERE id = ?').get(projectId) !== null
}
