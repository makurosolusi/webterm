// Starts agents whose spawn card a human approved (WS-19) and cancels those whose card was rejected.
// The ledger approval (`agent-<agentId>[-n]`) is the only thing that releases an `approval_pending`
// agent; it is consumed (single use) before launch.
import type { Database } from 'bun:sqlite'
import { consumeApproval } from '../../ledger/ledgerApproval'
import { createLogger } from '../../logs'
import type { AgentExecutor } from './agentExecutor'

const log = createLogger('central.agents')
const SWEEP_LIMIT = 100

/** Resumes every `approval_pending` agent whose approval is approved, cancels rejected ones; returns the count started. */
export async function resumeApprovedAgents(db: Database, executor: AgentExecutor, now: () => number): Promise<number> {
  const rows = db.query(
    `SELECT g.id AS agent_id, g.approval_id, a.status, d.action_digest AS digest
     FROM central_agents g JOIN approval a ON a.id = g.approval_id JOIN decision d ON d.id = a.decision_id
     WHERE g.state = 'approval_pending' AND a.status IN ('approved', 'rejected') ORDER BY g.last_event_at ASC LIMIT ?`,
  ).all(SWEEP_LIMIT) as { agent_id: string; approval_id: string; status: string; digest: string }[]
  let started = 0
  for (const row of rows) {
    try {
      if (row.status === 'rejected') {
        executor.reject(row.agent_id)
        continue
      }
      if (!consumeApproval({ db, now }, row.approval_id, { digest: row.digest })) continue
      const result = await executor.resume(row.agent_id)
      if (result.ok) started += 1
      else log.warn('agent.resume_failed', 'approved agent could not start', { agentId: row.agent_id, code: result.code })
    } catch (err) {
      log.error('agent.resume_error', 'resume after approval threw', { agentId: row.agent_id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return started
}
