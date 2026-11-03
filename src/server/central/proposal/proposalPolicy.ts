import type { Database } from 'bun:sqlite'
import { defaultRegistry } from '../tools/defaultRegistry'
import { ALLOW_ALL_GUARD } from '../tools/toolExec'
import { type ToolCtx, type ToolValidationCode, tierWithin } from '../tools/toolTypes'
import { validateToolInput } from '../tools/toolValidate'
import type { ProposalBlock } from './proposalParser'

export type ProposalCode = 'planner_off' | 'tools_read_only' | 'unknown_tool' | ToolValidationCode
export interface PolicyInput { planner: boolean; toolsWrite: boolean; conversationId: string; db: Database }
export interface ValidProposal extends ProposalBlock { projectId: string }
export interface PolicyResult { ok: boolean; code?: ProposalCode; proposal?: ValidProposal }
/** Highest tier a text proposal may carry; R2+ goes through approval cards (later workstreams). */
export const PROPOSAL_MAX_TIER = 'R1'

/** Gate planner/tools flags, then validate the block against its registered tool. */
export function validateProposal(block: ProposalBlock, policy: PolicyInput): PolicyResult {
  if (!policy.planner) return { ok: false, code: 'planner_off' }
  if (!policy.toolsWrite) return { ok: false, code: 'tools_read_only' }
  const registry = defaultRegistry()
  const def = registry.get(block.tool)
  if (!def || !tierWithin(def.tier, PROPOSAL_MAX_TIER)) return { ok: false, code: 'unknown_tool' }
  const ctx: ToolCtx = { db: policy.db, registry, guard: ALLOW_ALL_GUARD, maxTier: PROPOSAL_MAX_TIER, conversationId: policy.conversationId, now: Date.now }
  const checked = validateToolInput(def, block.input, ctx)
  if (!checked.ok) return { ok: false, code: checked.code }
  return { ok: true, proposal: { ...block, projectId: checked.projectId as string } }
}
