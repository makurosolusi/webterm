import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { type LedgerContext, getRow } from '../../ledger/ledgerCore'
import { proposeGoal } from '../goalStore'
import { createPlanStore } from '../../orchestrator/plan'
import { assignControl } from '../../orchestratorControlService'
import { approvalDigest, getApproval, requestApproval } from '../../ledger/ledgerApproval'
import type { ValidProposal } from './proposalPolicy'

export interface ApplyResult { ok: boolean; tool: string; projectId?: string; taskId?: string; goalVersion?: number; planVersion?: number; approvalId?: string; expiresAt?: number; reused?: boolean; code?: string }
function ctx(db: Database): LedgerContext { return { db, now: () => Date.now() } }
function audit(db: Database, result: ApplyResult): void {
  appendEvent(ctx(db), { kind: 'central.proposal', actor: 'central', ...(result.projectId ? { projectId: result.projectId } : {}), payload: { tool: result.tool, ok: result.ok, ...(result.projectId ? { projectId: result.projectId } : {}), ...(result.approvalId ? { approvalId: result.approvalId } : {}), ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.goalVersion ? { goalVersion: result.goalVersion } : {}), ...(result.planVersion ? { planVersion: result.planVersion } : {}), ...(result.code ? { code: result.code } : {}) } })
}
export async function applyProposal(db: Database, proposal: ValidProposal): Promise<ApplyResult> {
  try {
    if (proposal.tool === 'approval.request') {
      const input = proposal.input
      if (typeof input.taskId === 'string' && getApproval(ctx(db), `central-${String(input.requestId)}`) === null && getRow(ctx(db).db, 'SELECT 1 AS one FROM task WHERE id = ?', input.taskId) === null) {
        const result: ApplyResult = { ok: false, tool: proposal.tool, projectId: proposal.projectId, code: 'task_not_found' }
        audit(db, result)
        return result
      }
      const approvalId = `central-${String(input.requestId)}`
      const existing = getApproval(ctx(db), approvalId)
      if (existing) {
        const same = existing.projectId === proposal.projectId && existing.kind === input.kind && existing.taskId === (input.taskId ?? null) && approvalDigest(existing.request) === approvalDigest(input.request)
        const result: ApplyResult = same
          ? { ok: true, tool: proposal.tool, projectId: proposal.projectId, approvalId, expiresAt: existing.expiresAt ?? undefined, reused: true }
          : { ok: false, tool: proposal.tool, projectId: proposal.projectId, code: 'request_conflict' }
        audit(db, result)
        return result
      }
      let challenge
      try {
        challenge = requestApproval(ctx(db), { id: approvalId, projectId: proposal.projectId, kind: String(input.kind), request: input.request, ...(input.taskId ? { taskId: String(input.taskId) } : {}) })
      } catch {
        const result: ApplyResult = { ok: false, tool: proposal.tool, projectId: proposal.projectId, code: 'invalid_request' }
        audit(db, result)
        return result
      }
      const result: ApplyResult = { ok: true, tool: proposal.tool, projectId: proposal.projectId, approvalId: challenge.id, expiresAt: challenge.expiresAt }
      audit(db, result)
      return result
    }
    if (proposal.tool === 'task.assign') {
      const { createLedger } = await import('../../ledger/ledger')
      const ledger = createLedger(db, { now: Date.now })
      const result = await assignControl({ projectId: proposal.projectId, itemId: proposal.input.itemId as string, expectedVersion: proposal.input.expectedVersion as number, ...(proposal.input.assignee ? { assignee: proposal.input.assignee as string } : {}) }, { ledger: { mode: 'on', path: '', db, ledger, close() {} }, enabled: process.env.WEBTERM_ORCHESTRATOR_RUN === 'on' })
      const body = result.body as { taskId?: unknown; planVersion?: unknown; error?: unknown }
      const output: ApplyResult = result.status === 200
        ? { ok: true, tool: proposal.tool, projectId: proposal.projectId, taskId: String(body.taskId), planVersion: Number(body.planVersion) }
        : { ok: false, tool: proposal.tool, projectId: proposal.projectId, code: String(body.error ?? 'invalid_proposal') }
      audit(db, output)
      return output
    }
    if (proposal.tool === 'goal.propose') {
      const goal = proposeGoal(db, { projectId: proposal.projectId, draft: proposal.input as never, actor: { id: 'central', kind: 'central' }, expectedVersion: proposal.input.expectedVersion as number | null | undefined })
      const result = { ok: true, tool: proposal.tool, projectId: proposal.projectId, goalVersion: goal.version } as ApplyResult
      audit(db, result)
      return result
    }
    const plans = createPlanStore(db)
    const current = plans.get(proposal.projectId)
    const input = { projectId: proposal.projectId, items: proposal.input.items as never[] }
    const plan = current
      ? plans.replace({ ...input, expectedVersion: (proposal.input.expectedVersion as number | undefined) ?? current.version, status: 'draft' } as never)
      : plans.create({ ...input, status: 'draft' } as never)
    const result = { ok: true, tool: proposal.tool, projectId: proposal.projectId, planVersion: plan.version } as ApplyResult
    audit(db, result)
    return result
  } catch (err) {
    const result = { ok: false, tool: proposal.tool, projectId: proposal.projectId, code: err instanceof Error && 'code' in err ? String((err as Error & { code: unknown }).code) : 'invalid_proposal' }
    audit(db, result)
    return result
  }
}
