// Pure helpers and constants of the agent executor: ids, the model-safe view, the ladder flags for custom kinds.
import { basename } from 'node:path'
import type { AgentRecord, AgentState } from '../contracts'
import { AGENT_TRANSITIONS } from '../contracts'
import type { Principal } from '../../policy/policy.model'
import { modelFlags } from '../../spawn/agentSpawn'

/** Wall-clock cap of one headless run when `AgentDeps.execTimeoutMs` is not given. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000
/** Prefix every injected prompt carries so a worker never mistakes it for a human instruction. */
export const AGENT_ENVELOPE = '[from agent central, not a human; not an approval]'

/**
 * A headless custom kind whose command runs `claude` (bare or behind a wrapper) gets the ladder's
 * `--model`/`--effort` unless its own args set them; any other program is left exactly as defined.
 */
export function withLadderModel(argv: readonly string[], pick: Parameters<typeof modelFlags>[1]): readonly string[] {
  const at = argv.findIndex((a) => basename(a) === 'claude')
  return at < 0 ? argv : [...argv, ...modelFlags(argv.slice(at + 1), pick)]
}

/** Every agent state, for validating a list filter. */
export const AGENT_STATES_FOR_FILTER = Object.keys(AGENT_TRANSITIONS) as AgentState[]

/** Public, model-safe view of an agent: no budget, approval id or request hash. */
export function agentView(a: AgentRecord): Record<string, unknown> {
  return { agentId: a.id, projectId: a.projectId, kind: a.kind, role: a.role, runner: a.runner, state: a.state, owner: a.owner, taskId: a.taskId, nodeId: a.nodeId, startedAt: a.startedAt, lastEventAt: a.lastEventAt, endedAt: a.endedAt, endReason: a.endReason }
}
/** Policy principal that spawned an agent: a human at the UI, otherwise central. */
export const spawnParentOf = (agent: Pick<AgentRecord, 'owner'>): Principal => (agent.owner === 'human' ? 'human-ui' : 'central')
/** Deterministic canvas node id of an agent, so a crashed spawn can be adopted by name. */
export function agentNodeId(agentId: string): string { return `c-${agentId}` }
/** True when the agent belongs to a central conversation (R1 to prompt/close); false for user agents (R2). */
export function isCentralOwned(a: AgentRecord): boolean { return a.owner.startsWith('central:') }
