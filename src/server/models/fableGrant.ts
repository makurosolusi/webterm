// Fable (the top, most expensive model) needs a grant from a person. A grant is a ledger approval of kind
// `model.fable`: no new table. Pending = the card in Needs you; approved + `request.granted` = an active
// grant (scope: this conversation/node, or the whole project); rejected = denied or revoked. Only a human
// actor can decide the kind (ledgerApproval `HUMAN_ONLY_KINDS`), so Central or a worker can ask, never answer.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, type LedgerContext } from '../ledger/ledgerCore'
import { isHumanActor, requestApproval } from '../ledger/ledgerApproval'
import { LedgerError } from '../ledger/ledgerModel'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'

const log = createLogger('models.fable')
export const FABLE_KIND = 'model.fable'
const DAY_MS = 24 * 60 * 60_000

/** What a grant is for: one Central conversation, one agent node, or a project/workspace. */
export interface FableTarget { kind: 'conversation' | 'node' | 'project'; id: string; projectId?: string | null }
/** The human's choice on the card: just this target (narrowest, the default) or the whole project. */
export type FableScope = 'target' | 'project'
export const FABLE_SCOPES: readonly FableScope[] = ['target', 'project']

interface FableRequest { title: string; conversationId?: string; /** The project/workspace id a project-wide grant covers (the ledger `projectId` is only the row the approval hangs on). */ scopeProjectId?: string | null; target: { kind: string; id: string }; projectId: string; granted?: { scope: FableScope; by: string; at: number } }

const parse = (raw: unknown): Record<string, unknown> => {
  try { return JSON.parse(String(raw ?? '{}')) as Record<string, unknown> } catch { return {} }
}

/** True when a still-active grant covers `target` (its own, or its project's). No db = no grant. */
export function isFableGranted(db: Database | null, target: FableTarget | null): boolean {
  if (!db || !target) return false
  const rows = allRows(db, `SELECT request_json FROM approval WHERE kind = ? AND status = 'approved'`, FABLE_KIND)
  return rows.some((r) => {
    const req = parse(r['request_json']) as Partial<FableRequest>
    // Approved on a surface that cannot pick a scope (Telegram button, legacy route) = the narrowest scope.
    const scope = req.granted?.scope ?? 'target'
    if (scope === 'project') return !!req.scopeProjectId && (req.scopeProjectId === target.projectId || (target.kind === 'project' && req.scopeProjectId === target.id))
    return req.target?.kind === target.kind && req.target.id === target.id
  })
}

/** Same check against the process ledger, for callers that hold no db (agent chat). */
export const isFableGrantedActive = (target: FableTarget | null): boolean => isFableGranted(activeLedgerRuntime()?.db ?? null, target)

function projectRow(db: Database, wanted: string | null | undefined): string | null {
  const hit = wanted ? getRow(db, 'SELECT id FROM project WHERE id = ?', wanted) : null
  return String((hit ?? getRow(db, 'SELECT id FROM project ORDER BY created_at LIMIT 1'))?.['id'] ?? '') || null
}

/**
 * Opens the grant card for `target` (idempotent: one pending card per target, and no new card for 24 h after a
 * denial or an expired card, so a run that keeps asking for Fable does not nag). Null = no card was needed or
 * possible (the run still goes on Opus; the caller already says so).
 */
export function requestFableGrant(ctx: LedgerContext, target: FableTarget): string | null {
  const recent = allRows(ctx.db, `SELECT request_json, status, updated_at FROM approval WHERE kind = ? AND status != 'approved' AND updated_at > ?`, FABLE_KIND, ctx.now() - DAY_MS)
  if (recent.some((r) => (parse(r['request_json']) as Partial<FableRequest>).target?.id === target.id)) return null
  const projectId = projectRow(ctx.db, target.projectId)
  if (!projectId) return null // no project row to hang an approval on yet; nothing to ask about
  const request: FableRequest = { title: `Allow Fable for this ${target.kind}?`, target: { kind: target.kind, id: target.id }, projectId, scopeProjectId: target.projectId ?? (target.kind === 'project' ? target.id : null), ...(target.kind === 'conversation' ? { conversationId: target.id } : {}) }
  try {
    return requestApproval(ctx, { projectId, kind: FABLE_KIND, request, ttlMs: DAY_MS }).id
  } catch (err) {
    log.warn('fable.request_failed', `Cannot open the Fable grant card for ${target.kind} ${target.id}`, { cause: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Records the scope the person chose on an approved card (call in the same transaction as the decision). Narrowest by default. */
export function stampFableScope(ctx: LedgerContext, approvalId: string, actor: string, scope: FableScope = 'target'): void {
  if (!isHumanActor(actor)) throw new LedgerError(`fable grant ${approvalId}: only a person can grant (actor ${actor})`)
  if (!FABLE_SCOPES.includes(scope)) throw new LedgerError(`fable grant ${approvalId}: unknown scope ${String(scope)}`)
  const row = getRow(ctx.db, 'SELECT request_json FROM approval WHERE id = ? AND kind = ? AND status = ?', approvalId, FABLE_KIND, 'approved')
  if (!row) throw new LedgerError(`fable grant ${approvalId}: not an approved ${FABLE_KIND} approval`)
  const req = { ...parse(row['request_json']), granted: { scope, by: actor, at: ctx.now() } }
  execWrite(ctx.db, 'UPDATE approval SET request_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(req), ctx.now(), approvalId)
}

/** Takes a grant back: later runs on that scope fall to Opus again. Person-only; false when it was not an active grant. */
export function revokeFableGrant(ctx: LedgerContext, approvalId: string, actor: string): boolean {
  if (!isHumanActor(actor)) throw new LedgerError(`fable grant ${approvalId}: only a person can revoke (actor ${actor})`)
  const row = getRow(ctx.db, 'SELECT request_json FROM approval WHERE id = ? AND kind = ? AND status = ?', approvalId, FABLE_KIND, 'approved')
  if (!row) return false
  const req = { ...parse(row['request_json']), revoked: { by: actor, at: ctx.now() } }
  execWrite(ctx.db, `UPDATE approval SET status = 'rejected', request_json = ?, approved_by = ?, updated_at = ? WHERE id = ?`, JSON.stringify(req), actor, ctx.now(), approvalId)
  return true
}

/** Active grants for the settings/UI list. */
export function listFableGrants(db: Database): { id: string; scope: FableScope; target: { kind: string; id: string }; projectId: string; by: string; at: number }[] {
  return allRows(db, `SELECT id, request_json FROM approval WHERE kind = ? AND status = 'approved' ORDER BY updated_at DESC LIMIT 200`, FABLE_KIND).flatMap((r) => {
    const req = parse(r['request_json']) as Partial<FableRequest>
    return req.target ? [{ id: String(r['id']), scope: req.granted?.scope ?? 'target', target: req.target, projectId: String(req.projectId), by: req.granted?.by ?? 'human', at: req.granted?.at ?? 0 }] : []
  })
}

/** `requestFableGrant` against the process ledger (agent chat holds no db); null when no ledger runs. */
export function requestFableGrantActive(target: FableTarget): string | null {
  const db = activeLedgerRuntime()?.db
  return db ? requestFableGrant({ db, now: Date.now }, target) : null
}
