// Human side of a held Claude permission prompt (F3-b), mounted under `/api/approvals/permission`
// by `approvalHumanApi.ts`, so it inherits that route's UI-only gate (no agent credential, browser
// page only). "Allow once" / "Deny" decide the ledger approval the hook is waiting on; "Always allow"
// first writes a permanent human-ui rule (K4) and then allows, so later identical requests answer
// themselves in `permission.wait.ts`.
import type { Database } from 'bun:sqlite'
import { allRows } from '../ledger/ledgerCore'
import { decideApproval, toApproval } from '../ledger/ledgerApproval'
import { LedgerError } from '../ledger/ledgerModel'
import type { Policy } from '../policy/policy.decide'
import { PERMISSION_KIND, TOOL_CAPABILITY_PREFIX } from './permission.model'
import type { PermissionRequestView } from './permission.wait'

export interface PendingPermission extends PermissionRequestView {
  id: string
  expiresAt: number | null
  createdAt: number
}

type Result = { status: number; body: unknown }

const LIST_MAX = 50

/** Pending, unexpired permission prompts, oldest first. */
export function listPendingPermissions(db: Database, now: number): PendingPermission[] {
  return allRows(db, `SELECT * FROM approval WHERE kind = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC, id ASC LIMIT ?`, PERMISSION_KIND, now, LIST_MAX).map((row) => {
    const a = toApproval(row)
    return { ...(a.request as PermissionRequestView), id: a.id, expiresAt: a.expiresAt, createdAt: a.createdAt }
  })
}

/** One recent prompt that "Always allow / Always block" can turn into a rule (Settings › Rules & secrets). */
export interface RecentPermission { tool: string; label: string; pattern: string; node: string; createdAt: number }

const RECENT_SCAN = 200

/** The newest prompts with a safe pattern, one per tool + pattern, newest first (decided or not). */
export function listRecentPermissions(db: Database, limit = 10): RecentPermission[] {
  const out: RecentPermission[] = []
  const seen = new Set<string>()
  for (const row of allRows(db, 'SELECT * FROM approval WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?', PERMISSION_KIND, RECENT_SCAN)) {
    const a = toApproval(row)
    const v = a.request as PermissionRequestView
    const key = `${v.tool}\u0000${v.pattern}`
    if (!v.pattern || seen.has(key)) continue
    seen.add(key)
    out.push({ tool: v.tool, label: v.label, pattern: v.pattern, node: v.node, createdAt: a.createdAt })
    if (out.length >= limit) break
  }
  return out
}

const CHOICES = ['allow', 'deny', 'always'] as const
type Choice = (typeof CHOICES)[number]

/** `POST { id, choice }`. 409 when the prompt is gone (decided elsewhere, expired, or the hook left). */
export function decidePermission(db: Database, policy: Policy | null, body: Record<string, unknown>, actor: string, now: number): Result {
  const id = typeof body.id === 'string' ? body.id : ''
  const choice = body.choice as Choice
  if (!id || id.length > 200) return { status: 400, body: { error: 'invalid_id' } }
  if (!CHOICES.includes(choice)) return { status: 400, body: { error: 'invalid_choice' } }
  const row = allRows(db, `SELECT a.*, d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id
    WHERE a.id = ? AND a.kind = ?`, id, PERMISSION_KIND)[0]
  if (!row) return { status: 404, body: { error: 'not_found' } }
  const a = toApproval(row)
  if (a.status !== 'pending' || (a.expiresAt !== null && a.expiresAt <= now)) return { status: 409, body: { error: 'not_pending' } }
  const view = a.request as PermissionRequestView
  let grantId: string | undefined
  if (choice === 'always') {
    if (!policy) return { status: 503, body: { error: 'policy_off' } }
    if (!view.pattern) return { status: 400, body: { error: 'no_safe_pattern' } }
    const g = policy.createGrant('human-ui', { subject: 'node:*', capability: `${TOOL_CAPABILITY_PREFIX}${view.tool}`, scope: view.pattern, effect: 'allow' })
    if (!g.ok) return { status: g.status, body: { error: g.code } }
    grantId = g.grant.id
  }
  let decided
  try {
    decided = decideApproval({ db, now: () => now }, id, {
      actor, approve: choice !== 'deny', digest: String(row['action_digest']), nonce: String(row['nonce']), now,
    })
  } catch (err) {
    // Lost a race with Telegram, the other tab or the hook's own expiry: the prompt is no longer open.
    if (err instanceof LedgerError) return { status: 409, body: { error: 'not_pending', detail: err.message } }
    throw new Error(`permission decide ${id} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  return { status: 200, body: { id, status: decided.status, ...(grantId ? { grantId } : {}) } }
}
