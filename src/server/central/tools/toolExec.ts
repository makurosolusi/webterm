import { callFingerprint, createMemoryReceiptLog, type Receipt, type ReceiptLog, runOnce } from '../../capability/capability.receipt'
import { checkpointBeforeAction } from '../../checkpoint/checkpoint.service'
import { type ApprovalStatus, getApproval } from '../../ledger/ledgerApproval'
import { auditTool } from './toolAudit'
import { type ControlGuard, type ExecResult, type ToolCtx, type ToolDef, type ToolInput, type ToolResult, defEnabled, tierWithin } from './toolTypes'
import { validateToolInput } from './toolValidate'

/** Guard that permits everything, for callers whose gating happened upstream (proposal pipeline). */
export const ALLOW_ALL_GUARD: ControlGuard = { check: () => ({ ok: true }) }

export interface ExecOptions { /** Input already passed `validateToolInput` (proposal pipeline); skips re-validation. */ prevalidated?: boolean }

/** Single execution gate: flag, validate, tier, guard, handler, audit. Every outcome is audited. */
export async function execTool(ctx: ToolCtx, name: string, args: ToolInput, options: ExecOptions = {}): Promise<ExecResult> {
  return (await execAudited(ctx, name, args, options)).result
}

async function execAudited(ctx: ToolCtx, name: string, args: ToolInput, options: ExecOptions): Promise<{ result: ExecResult; auditSeq: number }> {
  const def = ctx.registry.get(name)
  // Only a validated project id may reach the audit event (it is a ledger reference).
  const trusted = options.prevalidated && typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined
  const finish = (result: ToolResult, projectId = trusted): { result: ExecResult; auditSeq: number } => {
    const auditSeq = auditTool(ctx, name, def, projectId, result)
    return { result: { ...result, tool: name, ...(projectId ? { projectId } : {}) }, auditSeq }
  }
  if (!def) return finish({ ok: false, code: 'unknown_tool' })
  if (!defEnabled(def, ctx.env ?? process.env)) return finish({ ok: false, code: 'flag_off' })
  let projectId = trusted
  if (!options.prevalidated) {
    const checked = validateToolInput(def, args, ctx)
    if (!checked.ok) return finish({ ok: false, code: checked.code })
    projectId = checked.projectId
  }
  if (!tierWithin(def.tier, ctx.maxTier)) return finish({ ok: false, code: 'tier_denied' }, projectId)
  const verdict = ctx.guard.check({ tool: name, tier: def.tier, ...(projectId ? { projectId } : {}), input: args })
  if (!verdict.ok) return finish({ ok: false, code: verdict.code || 'guard_denied' }, projectId)
  // F3-c: snapshot the project's workspace before any effect (R1+) so Rewind can undo it; never throws.
  await checkpointBeforeAction(ctx.db, projectId, def.tier)
  return finish(await runHandler(def, ctx, args, projectId), projectId)
}

async function runHandler(def: ToolDef, ctx: ToolCtx, args: ToolInput, projectId: string | undefined): Promise<ToolResult> {
  try {
    return await def.handler(ctx, args, projectId)
  } catch (err) {
    // The error becomes a coded, audited result (message dropped: it may echo input); nothing is swallowed.
    return { ok: false, code: err instanceof Error && 'code' in err ? String((err as Error & { code: unknown }).code) : 'invalid_proposal' }
  }
}

/** Codes meaning "not allowed" rather than "went wrong"; they map to receipt outcome `denied`. */
const DENIED = new Set(['flag_off', 'tier_denied', 'guard_denied', 'forbidden_key', 'approval_required', 'approval_rejected', 'budget_exceeded', 'level_denied', 'policy_denied', 'breaker_open'])
/** What the caller can do next for codes that have one obvious follow-up. */
const NEXT: Record<string, string> = {
  unknown_tool: 'cap.search {"query":"<words>"} lists the tools that exist',
  invalid_shape: 'cap.describe {"name":"<tool>"} shows the exact input schema',
  approval_required: 'an approval card is shown in the Central chat; tell the human, then retry the same call after they approve',
  approval_rejected: 'the human rejected this; do not retry it, tell them',
  tier_denied: 'propose it instead; a human approves higher tiers',
}
/** `approval_required` next step by the card's ledger status, so the model never points at a dead card. */
const APPROVAL_NEXT: Partial<Record<ApprovalStatus, string>> = {
  expired: 'the approval card expired before a decision; retry the same call to put a fresh card in the chat',
  rejected: NEXT['approval_rejected'],
  approved: 'the approval was already used or no longer matches this call; retry the same call for a fresh card',
}

const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'expired']

/** Card status of an approval-gated result: the handler's own, else the ledger status of the approvalId the call named. */
function approvalStatusOf(ctx: ToolCtx, result: ExecResult, args: ToolInput): ApprovalStatus | undefined {
  const own = result.data?.approvalStatus
  if (typeof own === 'string' && STATUSES.includes(own)) return own as ApprovalStatus
  if (result.ok || result.code !== 'approval_required') return undefined
  const named = typeof result.data?.approvalId === 'string' ? result.data.approvalId : args.approvalId
  if (typeof named !== 'string' || named === '') return undefined
  return getApproval({ db: ctx.db, now: ctx.now }, named)?.status
}

/** Maps an exec result to the uniform receipt; evidence is the audit event the gate itself wrote. */
export function toReceipt(result: ExecResult, auditSeq: number, approvalStatus?: ApprovalStatus): Receipt {
  const detail = result.ok ? 'ok' : (result.code ?? 'error')
  const outcome = result.ok ? 'ok' : DENIED.has(detail) ? 'denied' : 'error'
  const keys = result.data ? Object.keys(result.data) : []
  const next = result.ok ? null : (detail === 'approval_required' && approvalStatus ? APPROVAL_NEXT[approvalStatus] : undefined) ?? NEXT[detail] ?? null
  return {
    outcome, detail, next, operationId: null,
    evidence: { tool: result.tool, auditSeq, ...(result.projectId ? { projectId: result.projectId } : {}), ...(keys.length ? { dataKeys: keys } : {}), ...(approvalStatus ? { approvalStatus } : {}) },
  }
}

const sharedLog = createMemoryReceiptLog()

export interface ReceiptOptions extends ExecOptions {
  /** Same id + same call replays the first `ok` receipt instead of running again. */
  operationId?: string
  /** Defaults to a process-wide in-memory log (F1-c swaps in the event table). */
  log?: ReceiptLog
}

/** `execTool` returning a receipt, with idempotent replay by `operationId`. Projection entry point for MCP/HTTP (F2). */
export async function execToolReceipt(ctx: ToolCtx, name: string, args: ToolInput, options: ReceiptOptions = {}): Promise<{ receipt: Receipt; result?: ExecResult }> {
  let result: ExecResult | undefined
  const receipt = await runOnce(options.log ?? sharedLog, options.operationId, callFingerprint(name, { conversationId: ctx.conversationId, args }), async () => {
    const run = await execAudited(ctx, name, args, options)
    result = run.result
    return toReceipt(run.result, run.auditSeq, approvalStatusOf(ctx, run.result, args))
  })
  return { receipt, ...(result ? { result } : {}) }
}
