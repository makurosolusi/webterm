// Boot reconciler for central agents (RND/29b 4.8 "Restart"): an agent that claims a live process
// (provisioning/starting/working/waiting_input) but has none moves to `orphaned`, a legal terminal edge
// of the state machine, so no zombie turn waits for a worker that is gone. Idempotent.
import { createLogger } from '../../logs'
import type { AgentRecord, AgentState } from '../contracts'
import { AgentTransitionError } from './agentStateMachine'
import type { AgentStore } from './agentStore'

const log = createLogger('central')

/** States that imply a running worker process or session. */
export const PROCESS_STATES: readonly AgentState[] = ['provisioning', 'starting', 'working', 'waiting_input']
/** Upper bound of agents examined per boot pass. */
export const RECONCILE_LIMIT = 1000
/** `end_reason` written on reconciled agents. */
export const RECONCILE_REASON = 'reconciled_no_process'

export interface ReconcileDeps {
  store: AgentStore
  /** Whether the agent's process/session still exists (PTY node present, exec pid alive). */
  isAlive(agent: AgentRecord): boolean | Promise<boolean>
  limit?: number
}

export interface ReconcileReport {
  examined: number
  orphaned: string[]
  /** Transitions lost to a concurrent writer; they are re-examined on the next pass. */
  skipped: string[]
}

/** Moves process-less working agents to `orphaned`; a second run finds nothing left to do. */
export async function reconcileAgents(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { examined: 0, orphaned: [], skipped: [] }
  for (const agent of deps.store.listActive(deps.limit ?? RECONCILE_LIMIT)) {
    if (!PROCESS_STATES.includes(agent.state)) continue
    report.examined++
    if (await deps.isAlive(agent)) continue
    try {
      deps.store.transition(agent.id, 'orphaned', { reason: RECONCILE_REASON })
      report.orphaned.push(agent.id)
    } catch (err) {
      if (!(err instanceof AgentTransitionError)) throw new Error(`reconcile agent ${agent.id} (${agent.state}) failed`, { cause: err })
      report.skipped.push(agent.id)
      log.warn('central.agent.reconcile_skipped', 'agent reconcile transition refused', { agentId: agent.id, code: err.code })
    }
  }
  if (report.orphaned.length > 0) log.info('central.agent.reconciled', 'orphaned agents without a process', { count: report.orphaned.length })
  return report
}
