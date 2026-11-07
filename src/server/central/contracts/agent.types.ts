// Cross-WS contract: agent records and the worker state machine (RND/29b §4.6, §4.8; RND/22 §4.5).
// The transition table is data; enforcement lives in the agent state machine (WS-09).

/** Every lifecycle state of a central-managed worker agent. */
export type AgentState =
  | 'requested' | 'approval_pending' | 'provisioning' | 'starting'
  | 'working' | 'waiting_input' | 'candidate_done' | 'verifying'
  | 'accepted' | 'rejected' | 'closing' | 'closed'
  | 'failed' | 'timed_out' | 'lease_expired' | 'session_exited'
  | 'cancelled' | 'killed' | 'orphaned'

/** Terminal states: no outgoing transition. */
export const AGENT_TERMINAL_STATES = [
  'closed', 'failed', 'timed_out', 'lease_expired', 'session_exited', 'cancelled', 'killed', 'orphaned',
] as const satisfies readonly AgentState[]

const ABORTS = ['cancelled', 'killed', 'orphaned'] as const satisfies readonly AgentState[]
const RUNNING_ENDS = ['timed_out', 'lease_expired', 'session_exited', ...ABORTS] as const satisfies readonly AgentState[]

/** Legal `from -> to` edges; anything absent is illegal. `rejected -> working` is the retry (attempt < 3). */
export const AGENT_TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  requested: ['approval_pending', 'provisioning', ...ABORTS],
  approval_pending: ['provisioning', ...ABORTS],
  provisioning: ['starting', 'failed', ...ABORTS],
  starting: ['working', 'failed', ...RUNNING_ENDS],
  working: ['waiting_input', 'candidate_done', 'failed', ...RUNNING_ENDS],
  waiting_input: ['working', 'failed', ...RUNNING_ENDS],
  candidate_done: ['verifying', 'working', ...RUNNING_ENDS],
  verifying: ['accepted', 'rejected', 'failed', ...RUNNING_ENDS],
  rejected: ['working', 'failed', ...ABORTS],
  accepted: ['closing', ...ABORTS],
  closing: ['closed', 'failed', ...ABORTS],
  closed: [],
  failed: [],
  timed_out: [],
  lease_expired: [],
  session_exited: [],
  cancelled: [],
  killed: [],
  orphaned: [],
}

/** Harness of the worker: `claude` or a custom id; open on purpose. */
export type AgentKind = 'claude' | (string & {})

/** Worker (does the task) or reviewer (checks another agent's result). */
export type AgentRole = 'worker' | 'reviewer'

/** `pty` is a canvas node; `exec` is a headless argv-array process. */
export type AgentRunner = 'pty' | 'exec'

/** Who may close or prompt the agent without extra approval (RND/29 §4.5 row 4). */
export type AgentOwner = `central:${string}` | 'human' | 'orchestrator'

/** One row of `central_agents`; timestamps are epoch ms. */
export interface AgentRecord {
  id: string
  projectId: string
  nodeId: string | null
  kind: AgentKind
  role: AgentRole
  runner: AgentRunner
  taskId: string | null
  /** Lease fence token; stale holders must not write. */
  fence: number | null
  state: AgentState
  owner: AgentOwner
  approvalId: string | null
  budgetJson: string | null
  /** `sha256(projectId|itemId|planVersion|attempt)`; UNIQUE, makes spawn idempotent. */
  reqId: string
  startedAt: number | null
  lastEventAt: number | null
  endedAt: number | null
  endReason: string | null
}
