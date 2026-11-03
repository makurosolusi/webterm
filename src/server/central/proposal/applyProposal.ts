import type { Database } from 'bun:sqlite'
import { defaultRegistry } from '../tools/defaultRegistry'
import { ALLOW_ALL_GUARD, execTool } from '../tools/toolExec'
import type { ToolCtx } from '../tools/toolTypes'
import { PROPOSAL_MAX_TIER, type ValidProposal } from './proposalPolicy'

export interface ApplyResult { ok: boolean; tool: string; projectId?: string; taskId?: string; goalVersion?: number; planVersion?: number; approvalId?: string; expiresAt?: number; reused?: boolean; code?: string }

/** Executes an already-validated (planner/toolsWrite gated upstream) proposal through the registry and audits the outcome. */
export async function applyProposal(db: Database, proposal: ValidProposal): Promise<ApplyResult> {
  const ctx: ToolCtx = { db, registry: defaultRegistry(), guard: ALLOW_ALL_GUARD, maxTier: PROPOSAL_MAX_TIER, conversationId: 'global', now: Date.now }
  const { data, ...result } = await execTool(ctx, proposal.tool, proposal.input, { prevalidated: true })
  return { ...result, ...data } as ApplyResult
}
