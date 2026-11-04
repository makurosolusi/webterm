// Reads and human decisions on `eval_case` rows (v21). Capture lives in evalCase.capture.ts.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, parseJson, type Row } from '../ledger/ledgerCore'
import { REASON_MAX_CHARS, scrubText, type EvalCase, type EvalCaseStatus, type ProposedAction, type Rejection } from './evalCase.model'

export const EVAL_LIST_DEFAULT = 50
export const EVAL_LIST_MAX = 200
/** Export is a whole dataset in one document; capped so one click cannot build an unbounded body. */
export const EVAL_EXPORT_MAX = 5000
export const EVAL_STATUSES: readonly EvalCaseStatus[] = ['new', 'promoted', 'dismissed']

export class EvalCaseError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_reason', message: string) { super(message) }
}

const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function toEvalCase(r: Row): EvalCase {
  return {
    id: String(r['id']), source: String(r['source']) as EvalCase['source'], sourceRef: String(r['source_ref']),
    projectId: nullable(r['project_id']), workspaceId: nullable(r['workspace_id']), nodeId: nullable(r['node_id']),
    contextRef: nullable(r['context_ref']), inputText: nullable(r['input_text']),
    proposed: parseJson(r['proposed_json']) as ProposedAction, rejection: parseJson(r['rejection_json']) as Rejection,
    reason: nullable(r['reason']), status: String(r['status']) as EvalCaseStatus,
    rejectedAt: Number(r['rejected_at']), createdAt: Number(r['created_at']), updatedAt: Number(r['updated_at']),
  }
}

export function listEvalCases(db: Database, opts: { status?: EvalCaseStatus; limit?: number; offset?: number } = {}): { cases: EvalCase[]; total: number } {
  const limit = Math.min(EVAL_LIST_MAX, Math.max(1, Math.trunc(opts.limit ?? EVAL_LIST_DEFAULT)))
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  const where = opts.status ? 'WHERE status = ?' : ''
  const params = opts.status ? [opts.status] : []
  const total = Number(getRow(db, `SELECT COUNT(*) AS n FROM eval_case ${where}`, ...params)?.['n'] ?? 0)
  const cases = allRows(db, `SELECT * FROM eval_case ${where} ORDER BY rejected_at DESC, id LIMIT ? OFFSET ?`, ...params, limit, offset).map(toEvalCase)
  return { cases, total }
}

/** Promoted cases, oldest first: the replay order of `webterm eval run` and the export order. */
export function promotedEvalCases(db: Database, limit = EVAL_EXPORT_MAX): EvalCase[] {
  return allRows(db, `SELECT * FROM eval_case WHERE status = 'promoted' ORDER BY rejected_at, id LIMIT ?`, limit).map(toEvalCase)
}

/** Sets the status (and the user's reason when given, scrubbed like everything else). */
export function decideEvalCase(db: Database, id: string, status: Exclude<EvalCaseStatus, 'new'>, opts: { now: number; reason?: unknown; secrets: readonly string[] }): EvalCase {
  let reason: string | null | undefined
  if (opts.reason !== undefined && opts.reason !== null) {
    if (typeof opts.reason !== 'string' || opts.reason.length > REASON_MAX_CHARS) throw new EvalCaseError('invalid_reason', `reason: text up to ${REASON_MAX_CHARS} chars`)
    reason = opts.reason.trim() ? scrubText(opts.reason.trim(), opts.secrets) : null
  }
  const changed = reason === undefined
    ? execWrite(db, 'UPDATE eval_case SET status = ?, updated_at = ? WHERE id = ?', status, opts.now, id)
    : execWrite(db, 'UPDATE eval_case SET status = ?, reason = ?, updated_at = ? WHERE id = ?', status, reason, opts.now, id)
  if (changed === 0) throw new EvalCaseError('not_found', `eval case not found: ${id}`)
  return toEvalCase(getRow(db, 'SELECT * FROM eval_case WHERE id = ?', id)!)
}

/** The dataset document (`webterm-eval-cases/1`): what Export JSON downloads. */
export function exportEvalCases(db: Database, now: number): { format: string; exportedAt: number; cases: EvalCase[] } {
  return { format: 'webterm-eval-cases/1', exportedAt: now, cases: promotedEvalCases(db) }
}
