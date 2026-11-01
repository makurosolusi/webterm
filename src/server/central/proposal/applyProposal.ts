import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { type LedgerContext } from '../../ledger/ledgerCore'
import { proposeGoal } from '../goalStore'
import { createPlanStore } from '../../orchestrator/plan'
import { assignControl } from '../../orchestratorControlService'
import type { ValidProposal } from './proposalPolicy'

export interface ApplyResult { ok: boolean; tool: string; projectId?: string; taskId?: string; goalVersion?: number; planVersion?: number; code?: string }
function ctx(db: Database): LedgerContext { return { db, now: () => Date.now() } }
function audit(db: Database, result: ApplyResult): void {
  appendEvent(ctx(db), { kind: 'central.proposal', actor: 'central', ...(result.projectId ? { projectId: result.projectId } : {}), payload: { tool: result.tool, ok: result.ok, ...(result.projectId ? { projectId: result.projectId } : {}), ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.goalVersion ? { goalVersion: result.goalVersion } : {}), ...(result.planVersion ? { planVersion: result.planVersion } : {}), ...(result.code ? { code: result.code } : {}) } })
}
export async function applyProposal(db: Database, proposal: ValidProposal): Promise<ApplyResult> {
  try {
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
