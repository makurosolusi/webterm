// Completion of a central worker goes through the mandatory verifier (F4-c): exit 0 only makes the
// agent `candidate_done`; `accepted` needs a `done` verdict from system evidence (diff + project
// checks run by the server). The worker's exit code and output are its claim, nothing more.
import type { AgentRecord, AgentState } from '../contracts'
import type { LedgerContext } from '../../ledger/ledgerCore'
import { verifyWorktreeCompletion } from '../../verifier/verifier.checks'
import type { CompletionVerdict } from '../../verifier/verifier.judge'
import { recordCompletion } from '../../verifier/verifier.report'

export type VerifyAgentCompletion = (agent: AgentRecord, cwd: string) => Promise<CompletionVerdict>

/** Production verifier: the agent's worktree, its task id as the receipt id. */
export const verifyAgentWorktree: VerifyAgentCompletion = (agent, cwd) =>
  verifyWorktreeCompletion(cwd, { taskId: agent.taskId ?? agent.id })

export interface SettleDeps {
  verify: VerifyAgentCompletion
  worktree(agent: AgentRecord): Promise<string>
  move(id: string, to: AgentState, patch?: { reason?: string }): AgentRecord | null
  audit(agent: AgentRecord, phase: string, extra?: Record<string, unknown>): void
  ledger: () => LedgerContext | null
}

/** `candidate_done -> verifying -> accepted | rejected` (a verifier crash ends `failed`). */
export async function settleCandidate(deps: SettleDeps, agent: AgentRecord): Promise<AgentRecord | null> {
  const verifying = deps.move(agent.id, 'verifying')
  if (!verifying) return null
  let verdict: CompletionVerdict
  try {
    verdict = await deps.verify(verifying, await deps.worktree(verifying))
  } catch (err) {
    const failed = deps.move(agent.id, 'failed', { reason: 'verifier_error' })
    if (failed) deps.audit(failed, 'verify.error', { error: err instanceof Error ? err.name : 'unknown' })
    return failed
  }
  const settled = deps.move(agent.id, verdict.status === 'done' ? 'accepted' : 'rejected', { reason: verdict.reason })
  if (settled) {
    deps.audit(settled, 'verify', { status: verdict.status, reason: verdict.reason, summary: verdict.summary, receipt: verdict.receipt })
    recordCompletion({ verdict, taskId: agent.taskId ?? agent.id, worker: agent.id, projectId: agent.projectId, nodeId: agent.nodeId }, deps.ledger)
  }
  return settled
}
