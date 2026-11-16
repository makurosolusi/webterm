// Blocking approval for irreversible actions. Chat text is never consent: a decision stores a
// digest of the exact action + a nonce, expires, and can be consumed once.
import { createHash, randomUUID } from 'node:crypto'
import type { Row } from './ledgerModel'
import { LedgerError, LedgerNotFoundError } from './ledgerModel'
import {
  type LedgerContext,
  allRows,
  execInsert,
  execWrite,
  getRow,
  jsonOf,
  newId,
  parseJson,
  requireText,
  tx,
} from './ledgerCore'
import { createLogger } from '../logs'

const log = createLogger('ledger.approval')

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface Approval {
  id: string
  projectId: string | null
  taskId: string | null
  kind: string
  request: unknown
  status: ApprovalStatus
  approvedBy: string | null
  expiresAt: number | null
  createdAt: number
  updatedAt: number
}

export interface RequestApprovalInput {
  id?: string
  projectId: string
  taskId?: string
  kind: string
  request: unknown
  ttlMs?: number
}

export interface ApprovalChallenge {
  id: string
  digest: string
  nonce: string
  expiresAt: number
}

export interface DecideApprovalInput {
  actor: string
  approve: boolean
  digest: string
  nonce: string
  now?: number
}

/** Called after a card is created, decided or expired: the one hook every surface (UI, Telegram, routes) passes. */
export type ApprovalListener = (ctx: LedgerContext, approval: Approval) => void
const listeners = new Set<ApprovalListener>()

/** Subscribes to approval changes; returns the unsubscribe. */
export function onApprovalChange(listener: ApprovalListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(ctx: LedgerContext, approval: Approval): void {
  for (const listener of listeners) {
    try {
      listener(ctx, approval)
    } catch (err) {
      // The ledger row is already durable; a listener (stream fan-out) must never undo or block it.
      log.error('approval.listener_failed', 'approval change listener threw', { approvalId: approval.id, status: approval.status, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Kinds only a person may decide: an agent (Central, a worker, the classifier) can request them, never answer. */
export const HUMAN_ONLY_KINDS: ReadonlySet<string> = new Set(['model.fable'])

/** `human`, `human:*` (web page, root, loopback) or `telegram:*` (the allowlisted owner's button press). */
export const isHumanActor = (actor: string): boolean => actor === 'human' || actor.startsWith('human:') || actor.startsWith('telegram:')

const DEFAULT_TTL_MS = 15 * 60_000
const MAX_TTL_MS = 24 * 60 * 60_000

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
  return `{${entries.join(',')}}`
}

/** SHA-256 over a key-sorted JSON form, so key order cannot change the approved action. */
export function approvalDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function toApproval(r: Row): Approval {
  return {
    id: String(r['id']),
    projectId: r['project_id'] === null ? null : String(r['project_id']),
    taskId: r['task_id'] === null ? null : String(r['task_id']),
    kind: String(r['kind']),
    request: parseJson(r['request_json']),
    status: String(r['status']) as ApprovalStatus,
    approvedBy: r['approved_by'] === null ? null : String(r['approved_by']),
    expiresAt: r['expires_at'] === null ? null : Number(r['expires_at']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

function approvalById(ctx: LedgerContext, id: string): Approval {
  const row = getRow(ctx.db, 'SELECT * FROM approval WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('approval', id)
  return toApproval(row)
}

/** Expiry is lazy: reads report `expired` even before the sweeper rewrites the row. */
function effectiveStatus(approval: Approval, now: number): ApprovalStatus {
  if (approval.status === 'pending' && approval.expiresAt !== null && approval.expiresAt <= now) {
    return 'expired'
  }
  return approval.status
}

export function requestApproval(
  ctx: LedgerContext,
  input: RequestApprovalInput
): ApprovalChallenge {
  const kind = requireText(input.kind, 'approval.kind')
  const projectId = requireText(input.projectId, 'approval.projectId')
  const ttl = Math.min(MAX_TTL_MS, Math.max(1000, input.ttlMs ?? DEFAULT_TTL_MS))
  const now = ctx.now()
  const expiresAt = now + ttl
  const digest = approvalDigest(input.request)
  const nonce = randomUUID()
  const id = input.id ?? newId()
  const decisionId = newId()

  tx(ctx, () => {
    execInsert(
      ctx.db,
      `INSERT INTO decision (id, project_id, task_id, question, action_digest, nonce, scope,
         expires_at, single_use, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approval', ?, 1, ?)`,
      decisionId,
      projectId,
      input.taskId ?? null,
      kind,
      digest,
      nonce,
      expiresAt,
      now
    )
    execInsert(
      ctx.db,
      `INSERT INTO approval (id, project_id, decision_id, task_id, kind, request_json, status,
         expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      projectId,
      decisionId,
      input.taskId ?? null,
      kind,
      jsonOf(input.request, 'approval.request'),
      expiresAt,
      now,
      now
    )
  })
  notify(ctx, approvalById(ctx, id))
  return { id, digest, nonce, expiresAt }
}

export function getApproval(ctx: LedgerContext, id: string): Approval | null {
  const row = getRow(ctx.db, 'SELECT * FROM approval WHERE id = ?', id)
  if (!row) return null
  const approval = toApproval(row)
  return { ...approval, status: effectiveStatus(approval, ctx.now()) }
}

export function listApprovals(
  ctx: LedgerContext,
  opts: { projectId?: string; status?: ApprovalStatus; limit?: number } = {}
): Approval[] {
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)))
  const where: string[] = []
  const params: unknown[] = []
  if (opts.projectId !== undefined) {
    where.push('project_id = ?')
    params.push(opts.projectId)
  }
  if (opts.status !== undefined) {
    where.push('status = ?')
    params.push(opts.status)
  }
  const sql = `SELECT * FROM approval${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at ASC, id ASC LIMIT ?`
  const now = ctx.now()
  const rows = allRows(ctx.db, sql, ...params, limit).map((row) => {
    const approval = toApproval(row)
    return { ...approval, status: effectiveStatus(approval, now) }
  })
  // Expiry is applied after the SQL filter so a stale `pending` never leaks through a status query.
  return opts.status === undefined ? rows : rows.filter((a) => a.status === opts.status).slice(0, limit)
}

export function decideApproval(ctx: LedgerContext, id: string, input: DecideApprovalInput): Approval {
  const actor = requireText(input.actor, 'approval.actor')
  const at = input.now ?? ctx.now()
  const decided = tx(ctx, () => {
    const row = getRow(
      ctx.db,
      `SELECT a.*, d.action_digest, d.nonce, d.single_use
       FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`,
      id
    )
    if (!row) throw new LedgerNotFoundError('approval', id)
    if (HUMAN_ONLY_KINDS.has(String(row['kind'])) && !isHumanActor(actor)) {
      throw new LedgerError(`approval ${id} (${String(row['kind'])}) can only be decided by a person, not by actor ${actor}`)
    }
    if (String(row['status']) !== 'pending') {
      throw new LedgerError(`approval ${id} is already ${String(row['status'])}`)
    }
    const expiresAt = row['expires_at'] === null ? null : Number(row['expires_at'])
    if (expiresAt !== null && expiresAt <= at) {
      throw new LedgerError(`approval ${id} expired at ${expiresAt}`)
    }
    if (String(row['action_digest']) !== input.digest) {
      throw new LedgerError(`approval ${id} digest mismatch: action changed since request`)
    }
    if (String(row['nonce']) !== input.nonce) {
      throw new LedgerError(`approval ${id} nonce mismatch`)
    }
    const next: ApprovalStatus = input.approve ? 'approved' : 'rejected'
    execWrite(
      ctx.db,
      'UPDATE approval SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?',
      next,
      actor,
      at,
      id
    )
    return approvalById(ctx, id)
  })
  notify(ctx, decided)
  return decided
}

/**
 * One-shot consumption. Returns false when the approval is not approved, expired, or was already
 * consumed (`decision.single_use = 0`), so an action can never run twice from one consent.
 */
export function consumeApproval(
  ctx: LedgerContext,
  id: string,
  input: { digest: string; now?: number }
): boolean {
  const at = input.now ?? ctx.now()
  return tx(ctx, () => {
    const row = getRow(
      ctx.db,
      `SELECT a.status, a.expires_at, d.action_digest, d.single_use
       FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`,
      id
    )
    if (!row || String(row['status']) !== 'approved') return false
    if (Number(row['single_use']) !== 1) return false
    const expiresAt = row['expires_at'] === null ? null : Number(row['expires_at'])
    if (expiresAt !== null && expiresAt <= at) return false
    if (String(row['action_digest']) !== input.digest) return false
    execWrite(
      ctx.db,
      'UPDATE decision SET single_use = 0 WHERE id = (SELECT decision_id FROM approval WHERE id = ?)',
      id
    )
    return true
  })
}

export function expireApprovals(ctx: LedgerContext, now?: number): number {
  const at = now ?? ctx.now()
  const due = "status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?"
  const expired = tx(ctx, () => {
    const ids = allRows(ctx.db, `SELECT id FROM approval WHERE ${due}`, at).map((r) => String(r['id']))
    execWrite(ctx.db, `UPDATE approval SET status = 'expired', updated_at = ? WHERE ${due}`, at, at)
    return ids
  })
  for (const id of expired) notify(ctx, approvalById(ctx, id))
  return expired.length
}
