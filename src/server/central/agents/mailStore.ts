// Repository for `agent_mail` (RND/29b 4.8, RND/22 4.4): ephemeral per-project messaging between agents.
// Mail is data, never memory and never an approval; policy (caps, TTL, idempotency) lives here, not in callers.
import type { Database } from 'bun:sqlite'
import { type LedgerContext, allRows, execWrite, getRow, newId, tx, type Row } from '../../ledger/ledgerCore'
import { AGENT_TERMINAL_STATES, type AgentState } from '../contracts/agent.types'
import type { MailKind, MailRecord, MailSendInput } from '../contracts/mail.types'

export const MAIL_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_UNACKED_PER_TARGET = 20
export const MAX_MAIL_BODY_BYTES = 8 * 1024
export const MAIL_DEFAULT_PAGE = 20
export const MAIL_MAX_PAGE = 100
export const MAIL_KINDS: readonly MailKind[] = ['msg', 'ask', 'reply', 'done', 'escalate']
const REF_PATTERN = /^(central:[A-Za-z0-9._:-]{1,200}|agent:[A-Za-z0-9._-]{1,200})$/
const CENTRAL_PROJECT_PREFIX = 'central:central:project:'

export type MailSendCode = 'invalid_shape' | 'target_not_found' | 'target_closed' | 'cross_project' | 'agent_to_agent_denied' | 'mailbox_full' | 'req_conflict'
export type MailSendResult = { ok: true; mail: MailRecord; duplicate: boolean } | { ok: false; code: MailSendCode }
export interface MailPage { items: MailRecord[]; /** Pass back as `cursor` for the next page; null at the end. */ nextCursor: string | null }
export interface MailListOptions { limit?: number; cursor?: string; unackedOnly?: boolean }
export interface MailSendOptions { /** Only the integrator sets this, after verifying a context-link edge between the two workers. */
  allowAgentToAgent?: boolean }

/** True for `central:<conv>` or `agent:<id>` refs with a safe charset (they are embedded in the envelope prefix). */
export function isMailRef(value: unknown): value is string { return typeof value === 'string' && REF_PATTERN.test(value) }

function toRecord(r: Row): MailRecord {
  const createdAt = Number(r.created_at)
  return {
    id: String(r.id), projectId: String(r.project_id), threadId: String(r.thread_id ?? r.id),
    fromRef: String(r.from_ref), toRef: String(r.to_ref), kind: String(r.kind) as MailKind, body: String(r.body),
    reqId: String(r.req_id), createdAt,
    deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
    ackedAt: r.acked_at === null ? null : Number(r.acked_at),
    expiresAt: r.expires_at === null ? createdAt + MAIL_TTL_MS : Number(r.expires_at),
  }
}

export interface MailStore {
  /** Stores one mail; a repeated `reqId` from the same sender/target returns the original (`duplicate`). */
  send(fromRef: string, input: MailSendInput, options?: MailSendOptions): MailSendResult
  get(id: string): MailRecord | null
  /** Oldest-first page of a recipient's live (non-expired) mail. */
  list(toRef: string, options?: MailListOptions): MailPage
  /** Next live undelivered mail for the recipient, oldest first. */
  nextUndelivered(toRef: string): MailRecord | null
  /** Marks delivery once; later calls keep the first timestamp. */
  markDelivered(id: string): void
  /** Idempotent: acking an already acked (or expired) mail succeeds; false only when the mail is not addressed to `toRef`. */
  ack(id: string, toRef: string): boolean
  /** Live unacked count for a recipient (what the cap measures). */
  unackedCount(toRef: string): number
  /** Deletes expired rows; returns how many. */
  purgeExpired(): number
}

/** Creates the store over the ledger DB; `now` is injected so TTL is testable. */
export function createMailStore(db: Database, now: () => number = Date.now): MailStore {
  const lc: LedgerContext = { db, now }
  const unacked = (toRef: string): number =>
    Number(getRow(db, 'SELECT COUNT(*) AS n FROM agent_mail WHERE to_ref = ? AND acked_at IS NULL AND expires_at > ?', toRef, now())?.n ?? 0)

  function refProblem(ref: string, projectId: string, role: 'target' | 'sender'): MailSendCode | null {
    if (ref.startsWith('agent:')) {
      const row = getRow(db, 'SELECT project_id, state FROM central_agents WHERE id = ?', ref.slice('agent:'.length))
      if (row === null) return 'target_not_found'
      if (String(row.project_id) !== projectId) return 'cross_project'
      return role === 'target' && (AGENT_TERMINAL_STATES as readonly string[]).includes(String(row.state) as AgentState) ? 'target_closed' : null
    }
    // Project-scoped central conversations embed their project; any other conversation id is not project-bound.
    return ref.startsWith(CENTRAL_PROJECT_PREFIX) && ref.slice(CENTRAL_PROJECT_PREFIX.length) !== projectId ? 'cross_project' : null
  }

  function send(fromRef: string, input: MailSendInput, options: MailSendOptions = {}): MailSendResult {
    const bodyOk = typeof input.body === 'string' && input.body.trim().length > 0 && Buffer.byteLength(input.body, 'utf8') <= MAX_MAIL_BODY_BYTES
    const shapeOk = bodyOk && isMailRef(fromRef) && isMailRef(input.toRef) && MAIL_KINDS.includes(input.kind)
      && typeof input.projectId === 'string' && input.projectId !== '' && typeof input.reqId === 'string' && input.reqId !== '' && fromRef !== input.toRef
    if (!shapeOk) return { ok: false, code: 'invalid_shape' }
    return tx(lc, (): MailSendResult => {
      const existing = getRow(db, 'SELECT rowid AS seq, * FROM agent_mail WHERE req_id = ?', input.reqId)
      if (existing) {
        const same = String(existing.from_ref) === fromRef && String(existing.to_ref) === input.toRef && String(existing.project_id) === input.projectId
        return same ? { ok: true, mail: toRecord(existing), duplicate: true } : { ok: false, code: 'req_conflict' }
      }
      const problem = refProblem(input.toRef, input.projectId, 'target') ?? refProblem(fromRef, input.projectId, 'sender')
      if (problem) return { ok: false, code: problem }
      if (fromRef.startsWith('agent:') && input.toRef.startsWith('agent:') && !options.allowAgentToAgent) return { ok: false, code: 'agent_to_agent_denied' }
      if (unacked(input.toRef) >= MAX_UNACKED_PER_TARGET) return { ok: false, code: 'mailbox_full' }
      const id = newId()
      const createdAt = now()
      execWrite(db,
        'INSERT INTO agent_mail (id, project_id, thread_id, from_ref, to_ref, kind, body, req_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, input.projectId, input.threadId || id, fromRef, input.toRef, input.kind, input.body, input.reqId, createdAt, createdAt + MAIL_TTL_MS)
      return { ok: true, mail: toRecord(getRow(db, 'SELECT * FROM agent_mail WHERE id = ?', id) as Row), duplicate: false }
    })
  }

  return {
    send,
    get: (id) => { const row = getRow(db, 'SELECT * FROM agent_mail WHERE id = ?', id); return row ? toRecord(row) : null },
    list(toRef, options = {}) {
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? MAIL_DEFAULT_PAGE) || MAIL_DEFAULT_PAGE, 1), MAIL_MAX_PAGE)
      const after = Number(options.cursor ?? 0)
      const rows = allRows(db,
        `SELECT rowid AS seq, * FROM agent_mail WHERE to_ref = ? AND expires_at > ? AND rowid > ?${options.unackedOnly ? ' AND acked_at IS NULL' : ''} ORDER BY rowid LIMIT ?`,
        toRef, now(), Number.isFinite(after) ? after : 0, limit + 1)
      const page = rows.slice(0, limit)
      return { items: page.map(toRecord), nextCursor: rows.length > limit ? String(page[page.length - 1]?.seq) : null }
    },
    nextUndelivered(toRef) {
      const row = getRow(db, 'SELECT * FROM agent_mail WHERE to_ref = ? AND delivered_at IS NULL AND acked_at IS NULL AND expires_at > ? ORDER BY rowid LIMIT 1', toRef, now())
      return row ? toRecord(row) : null
    },
    markDelivered(id) { execWrite(db, 'UPDATE agent_mail SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL', now(), id) },
    ack(id, toRef) {
      if (getRow(db, 'SELECT 1 AS one FROM agent_mail WHERE id = ? AND to_ref = ?', id, toRef) === null) return false
      execWrite(db, 'UPDATE agent_mail SET acked_at = ? WHERE id = ? AND acked_at IS NULL', now(), id)
      return true
    },
    unackedCount: unacked,
    purgeExpired: () => execWrite(db, 'DELETE FROM agent_mail WHERE expires_at <= ?', now()),
  }
}
