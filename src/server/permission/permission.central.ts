// The Central agent answers a worker's held permission prompt before a human does
// (docs/decisions/central-approver.md). Pure gates + the one decide function behind the `permission.decide` tool.
// Hard limits live HERE, not in the model's prompt: whatever Central asks for, this file refuses it.
import type { Database } from 'bun:sqlite'
import { automaticAction } from '../central/automaticAction'
import type { AppendEventInput } from '../events/eventModel'
import { previewText } from '../events/producers'
import { escalateApprovalToHuman } from '../inbox/inboxItemStore'
import { toolImpact } from '../inbox/inboxItemModel'
import { decideApproval, toApproval } from '../ledger/ledgerApproval'
import { allRows, getRow } from '../ledger/ledgerCore'
import { LedgerError } from '../ledger/ledgerModel'
import { neverAutoReason } from '../policy/policy.classifier'
import { redactSecrets } from '../redactSecrets'
import { PERMISSION_KIND, TOOL_CAPABILITY_PREFIX, VIA_CENTRAL } from './permission.model'
import type { PermissionRequestView } from './permission.wait'

/** `approved_by` of a card Central decided, and the audit/event actor. */
export const CENTRAL_ACTOR = 'central'
/** How long Central has to decide before the same card goes to the human. Hook timeout (590 s) is untouched. */
export const CENTRAL_DECIDE_MS = 150_000
export const REASON_MAX = 200
/** Chat notices per hour; the rest of an hour's decisions are Timeline records only (bounded data). */
export const NOTICE_PER_HOUR = 20
const HOUR_MS = 3_600_000
/** Node ids that are Central's own session (its MCP identity); workers it spawned are ordinary nodes. */
const CENTRAL_OWN_NODE = /^central([:_-]|$)/i

export type CentralDecision = 'allow' | 'deny' | 'escalate'

/** Reason a held prompt must go to a human without asking Central, or null when Central may decide. */
export function centralHoldReason(a: { nodeId: string; tool: string; label: string; input?: unknown; cwd?: string | null; askRule?: boolean }): string | null {
  if (CENTRAL_OWN_NODE.test(a.nodeId)) return 'the request comes from Central itself'
  const never = neverAutoReason({
    capability: `${TOOL_CAPABILITY_PREFIX}${a.tool}`, tier: toolImpact(a.tool, a.label).tier,
    args: a.input && typeof a.input === 'object' ? a.input : { command: a.label }, askRule: a.askRule === true, cwd: a.cwd ?? null,
  })
  return never ? `needs a human: ${never}` : null
}

const reasons = new Map<string, string>()
const REASONS_CAP = 100
/** Central's stated reason for a decided card, for the hook reply (process memory; the hold lasts minutes at most). */
export function takeCentralReason(approvalId: string): string | null {
  const r = reasons.get(approvalId) ?? null
  reasons.delete(approvalId)
  return r
}

let noticeHour = -1
let noticesThisHour = 0
function noticeAllowed(at: number): boolean {
  const hour = Math.floor(at / HOUR_MS)
  if (hour !== noticeHour) { noticeHour = hour; noticesThisHour = 0 }
  return ++noticesThisHour <= NOTICE_PER_HOUR
}

export interface CentralDecideDeps { db: Database; now: () => number; record?: (e: AppendEventInput) => void }
export interface CentralDecideInput { approvalId: string; decision: CentralDecision; reason?: string; conversationId: string }
export type CentralOutcome =
  | { ok: true; status: 'approved' | 'rejected' | 'escalated' }
  | { ok: false; code: 'not_found' | 'not_permission' | 'not_pending' | 'not_held_for_central' | 'escalated' | 'needs_human'; detail?: string }

const clean = (s: string | undefined): string => previewText(s ?? '', REASON_MAX) ?? ''

/** Escalates the card to the human with the reason shown; false when it already is (or is no longer pending). */
export function escalateToHuman(deps: CentralDecideDeps, approvalId: string, reason: string): boolean {
  const shown = escalateApprovalToHuman({ db: deps.db, now: deps.now }, approvalId, `Central passed this to you: ${redactSecrets(reason).slice(0, REASON_MAX)}`)
  if (shown) deps.record?.({ kind: 'permission.escalated', source: 'permission', actor: CENTRAL_ACTOR, trust: 'trusted', subject: `approval:${approvalId}`, payload: { approvalId, reason: reason.slice(0, REASON_MAX) } })
  return shown
}

/** One Central decision on one held prompt; every refusal is a code, never a throw (bad input is not an outage). */
export function decideByCentral(deps: CentralDecideDeps, input: CentralDecideInput): CentralOutcome {
  const { db } = deps
  const at = deps.now()
  const row = allRows(db, `SELECT a.*, d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`, input.approvalId)[0]
  if (!row) return { ok: false, code: 'not_found' }
  const a = toApproval(row)
  // Limit (b): only a Claude permission prompt is Central's to decide; model.*, level, secret, spawn... stay human.
  if (a.kind !== PERMISSION_KIND) return { ok: false, code: 'not_permission' }
  if (a.status !== 'pending' || (a.expiresAt !== null && a.expiresAt <= at)) return { ok: false, code: 'not_pending' }
  const view = a.request as PermissionRequestView
  if (view.via !== VIA_CENTRAL) return { ok: false, code: 'not_held_for_central' }
  if (getRow(db, 'SELECT 1 AS x FROM inbox_item WHERE approval_id = ?', a.id)) return { ok: false, code: 'escalated', detail: 'a human already has this card' }
  const reason = clean(input.reason)
  if (input.decision === 'escalate') {
    escalateToHuman(deps, a.id, reason || 'no reason given')
    return { ok: true, status: 'escalated' }
  }
  // Limits (a) and (b) again at decision time: the gate at request time is not the only line.
  const hold = centralHoldReason({ nodeId: view.nodeId, tool: view.tool, label: view.label, input: view.input })
  if (hold) {
    escalateToHuman(deps, a.id, hold)
    return { ok: false, code: 'needs_human', detail: `${hold}; the card was passed to the human` }
  }
  try {
    decideApproval({ db, now: deps.now }, a.id, { actor: CENTRAL_ACTOR, approve: input.decision === 'allow', digest: String(row['action_digest']), nonce: String(row['nonce']), now: at })
  } catch (err) {
    // Lost a race with the hook's own expiry or the human: the card is no longer open.
    if (err instanceof LedgerError) return { ok: false, code: 'not_pending', detail: err.message }
    throw new Error(`central decide ${a.id} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (reasons.size >= REASONS_CAP) reasons.delete(reasons.keys().next().value as string)
  if (reason) reasons.set(a.id, reason)
  const verb = input.decision === 'allow' ? 'allowed' : 'denied'
  automaticAction({ db, now: deps.now, ...(deps.record ? { record: deps.record } : {}) }, {
    name: 'central_permission', actor: CENTRAL_ACTOR, subject: `approval:${a.id}`, nodeId: view.nodeId, projectId: a.projectId, noNotice: !noticeAllowed(at),
    text: `Central ${verb} ${view.node} running ${view.label}${reason ? `: ${reason}` : ''}. Settings > Claude > Permissions switches this off.`,
  })
  return { ok: true, status: input.decision === 'allow' ? 'approved' : 'rejected' }
}
