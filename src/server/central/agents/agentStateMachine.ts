import { AGENT_TERMINAL_STATES, AGENT_TRANSITIONS, type AgentState } from '../contracts'

/** Retry budget of `rejected -> working` (RND/29b 4.8): the third attempt is the last. */
export const MAX_AGENT_ATTEMPTS = 3

/** Refused or lost transition; `code` is stable (`illegal_transition`, `stale_fence`, `concurrent_update`, `agent_not_found`). */
export class AgentTransitionError extends Error {
  constructor(readonly code: string, readonly agentId: string, readonly from: AgentState | null, readonly to: AgentState | null) {
    super(`agent ${agentId}: ${code}${from && to ? ` (${from} -> ${to})` : ''}`)
    this.name = 'AgentTransitionError'
  }
}

/** True when `from -> to` is an edge of the state machine. */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return AGENT_TRANSITIONS[from].includes(to)
}

/** True for states without outgoing edges. */
export function isTerminalState(state: AgentState): boolean {
  return (AGENT_TERMINAL_STATES as readonly AgentState[]).includes(state)
}

/** Throws `illegal_transition` for an absent edge, or when a retry would exceed `MAX_AGENT_ATTEMPTS`. */
export function assertTransition(agentId: string, from: AgentState, to: AgentState, attempt = 1): void {
  if (!canTransition(from, to) || (from === 'rejected' && to === 'working' && attempt >= MAX_AGENT_ATTEMPTS)) {
    throw new AgentTransitionError('illegal_transition', agentId, from, to)
  }
}

/** Terminal states a typed resume may bring back to `working`: the process died but its Claude conversation lives on. */
export const RESUMABLE_STATES: readonly AgentState[] = ['orphaned', 'session_exited']

/** Throws `illegal_transition` unless `from` is a state a resume may revive; the general table stays closed. */
export function assertResumeFrom(agentId: string, from: AgentState): void {
  if (!RESUMABLE_STATES.includes(from)) throw new AgentTransitionError('illegal_transition', agentId, from, 'working')
}
