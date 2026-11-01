import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { type LedgerContext } from '../../ledger/ledgerCore'
import { proposeGoal } from '../goalStore'
import { createPlanStore } from '../../orchestrator/plan'
import type { ValidProposal } from './proposalPolicy'

export interface ApplyResult { ok: boolean; tool: string; projectId?: string; goalVersion?: number; planVersion?: number; code?: string }
function ctx(db: Database): LedgerContext { return { db, now: () => Date.now() } }
function audit(db: Database, result: ApplyResult): void {
  appendEvent(ctx(db), { kind: 'central.proposal', actor: 'central', ...(result.projectId ? { projectId: result.projectId } : {}), payload: { tool: result.tool, ok: result.ok, ...(result.projectId ? { projectId: result.projectId } : {}), ...(result.goalVersion ? { goalVersion: result.goalVersion } : {}), ...(result.planVersion ? { planVersion: result.planVersion } : {}), ...(result.code ? { code: result.code } : {}) } })
}
export function applyProposal(db: Database, proposal: ValidProposal): ApplyResult {
  try {
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
