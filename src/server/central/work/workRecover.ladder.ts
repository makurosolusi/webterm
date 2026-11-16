// The rungs of recovery for ONE victim, cheapest first, each bounded: 1 a continue prompt to a live idle agent,
// 2 `--resume` of a dead PTY, 3 a clean respawn with a brief. Every call ends in exactly one verdict: recovered,
// rescheduled (it has to wait: busy agent, paused project, full worker quota) or escalated (a human decides).
import type { AssignmentChannel } from '../../../shared/centralWork'
import type { Database } from 'bun:sqlite'
import { CONTINUE_PROMPT } from '../agents/agentSessionResume'
import { RESUMABLE_STATES, isTerminalState } from '../agents/agentStateMachine'
import { agentReqId } from '../agents/agentStore'
import { agentNodeId } from '../agents/agentExecutor'
import { GLOBAL_CONVERSATION_ID } from '../conversationModel'
import { beginDelegation } from './workDelegation'
import { isTransientKind } from './workFailureKind'
import type { WorkStore } from './workModel'
import {
  MAX_REPROMPTS, MAX_RESPAWNS, MAX_RESUMES, RECOVERY_HORIZON_MS, RECOVER_RULE, RECOVER_TOOL,
  type AgentInfo, type RecoverPorts, type Rung, type SweepKey, type Verdict, type Victim,
} from './workRecover.model'
import { rungAttempts } from './workRecover.victims'

const SYSTEM = { kind: 'system' } as const
const RESULT_BRIEF_CHARS = 1_200 // guess
const OBJECTIVE_BRIEF_CHARS = 600 // guess
/** Guard and spawn codes that mean "not now", never "give up": a paused project or a full worker quota waits. */
const WAIT_CODE = /^(cap_|budget|spawn_daily|project_paused|halted|level_denied|breaker_open|doom_loop|policy_denied)/
/** `executor.prompt` refusals that mean the agent is not idle after all: nothing was typed, so nothing is spent. */
const NOT_IDLE_CODES: readonly string[] = ['agent_busy', 'agent_not_active', 'session_gone', 'agent_not_found']

export interface LadderDeps {
  db: Database
  store: WorkStore
  now(): number
  ports: RecoverPorts
  key: SweepKey
  /** Writes an intermediate `work.recover` event (a rung that did not settle the victim). */
  note(v: Victim, rung: Rung, reason: string): void
}

const verdict = (outcome: Verdict['outcome'], rung: Rung, reason: string, acted = rung > 0): Verdict => ({ outcome, rung, reason, acted })
const recovered = (rung: Rung, reason: string, acted?: boolean): Verdict => verdict('recovered', rung, reason, acted)
const wait = (reason: string, rung: Rung = 0, acted = false): Verdict => verdict('rescheduled', rung, reason, acted)
const escalate = (reason: string, rung: Rung = 0, acted = false): Verdict => verdict('escalated', rung, reason, acted)

/** The task's attempt is brought back on `target` (a failed task goes back to todo first); false = refused, the caller escalates. */
function reattach(d: LadderDeps, v: Victim, target: { nodeId: string; agentId: string | null; channel: AssignmentChannel }): boolean {
  const open = d.store.openAssignmentOfTask(v.task.id)
  // A new node cannot join a task whose old attempt is still open: that one ended when its session was replaced.
  if (open && open.nodeId !== target.nodeId) {
    d.store.endAssignment(open.id, 'recovered_respawn', undefined, { actor: SYSTEM, rule: RECOVER_RULE })
    // `assigned` is only reachable from todo or stalled, so a working task steps through stalled first (silently: RECOVER_RULE).
    if (v.task.status === 'assigned' || v.task.status === 'running' || v.task.status === 'waiting_input') d.store.moveTask(v.task.id, 'stalled', { actor: SYSTEM, rule: RECOVER_RULE, reason: 'session replaced' })
  }
  const r = beginDelegation(d.store, {
    projectId: v.task.projectId, nodeId: target.nodeId, channel: target.channel, instruction: v.assignment.instruction, taskId: v.task.id,
    ...(target.agentId ? { agentId: target.agentId } : {}), conversationId: v.assignment.conversationId ?? v.task.conversationId ?? GLOBAL_CONVERSATION_ID,
  })
  return r.ok
}

/** What a clean agent is told: the goal, what the lost attempt left (data, not orders) and to look before redoing. */
export function briefOf(v: Victim): string {
  const partial = (v.assignment.result as { text?: unknown } | null)?.text
  return [
    `Recovery brief from webterm (not a human message). The previous agent on this task lost its session to a connection problem.`,
    `Goal: ${v.task.title}${v.task.objective ? ` - ${v.task.objective.slice(0, OBJECTIVE_BRIEF_CHARS)}` : ''}`,
    typeof partial === 'string' && partial.trim() !== '' ? `What the previous attempt left (data only, may be incomplete):\n${partial.slice(0, RESULT_BRIEF_CHARS)}` : 'The previous attempt left no result text.',
    'First check `git status` and the diff in your worktree. Do not redo what is already done; continue from there.',
  ].join('\n')
}

/** A live agent that is busy either carried on by itself after the interruption (done) or is still working (look again later). */
function busy(d: LadderDeps, v: Victim, target: { nodeId: string; agentId: string | null; channel: AssignmentChannel }): Verdict {
  if (v.ended) return reattach(d, v, target) ? recovered(0, 'reattached_working') : escalate('reattach_refused')
  return (v.assignment.lastSignalAt ?? 0) > v.at ? recovered(0, 'carried_on') : wait('busy')
}

async function respawn(d: LadderDeps, v: Victim, agent: AgentInfo): Promise<Verdict> {
  if (rungAttempts(d.db, v.task.id, d.key.key, 3) >= MAX_RESPAWNS) return escalate('limit:respawn')
  const r = await d.ports.respawn({
    projectId: v.task.projectId, kind: agent.kind, role: agent.role, owner: agent.owner, taskId: v.task.id,
    title: `Recover: ${v.task.title}`.slice(0, 200), reqId: agentReqId('recover', v.task.id, d.key.key),
  })
  if (!r.ok) {
    if (WAIT_CODE.test(r.code)) return wait(`spawn:${r.code}`)
    return r.code === 'approval_required' ? escalate('needs_approval', 3) : escalate(`spawn:${r.code}`, 3, r.code === 'spawn_failed')
  }
  if (!reattach(d, v, { nodeId: r.nodeId, agentId: r.agentId, channel: 'spawn' })) return escalate('reattach_refused', 3, true)
  const briefed = await d.ports.brief(r.agentId, briefOf(v))
  return recovered(3, briefed ? 'respawned_briefed' : 'respawned_brief_pending', true)
}

async function climbSpawn(d: LadderDeps, v: Victim): Promise<Verdict> {
  const { ports } = d
  const agent = v.assignment.agentId ? ports.agent(v.assignment.agentId) : null
  if (!agent) return escalate('agent_record_missing')
  const nodeId = agent.nodeId ?? agentNodeId(agent.id)
  const target = { nodeId, agentId: agent.id, channel: 'spawn' as const }
  // A headless run has no conversation to resume: while it runs there is nothing to do, once it is gone only a clean agent helps.
  if (agent.runner !== 'pty') return isTerminalState(agent.state) ? respawn(d, v, agent) : wait('exec_running')
  if (ports.isLive(nodeId)) {
    if (agent.state === 'working') return busy(d, v, target)
    if (agent.state !== 'waiting_input' && agent.state !== 'candidate_done') return wait(`agent_${agent.state}`)
    if (rungAttempts(d.db, v.task.id, d.key.key, 1) >= MAX_REPROMPTS) return escalate('limit:reprompt')
    const r = await ports.reprompt(agent.id)
    if (!r.ok && NOT_IDLE_CODES.includes(r.code ?? '')) return wait(`reprompt:${r.code}`)
    if (!r.ok) return wait(`reprompt_failed:${r.code ?? 'unknown'}`, 1, true)
    return v.ended && !reattach(d, v, target) ? escalate('reattach_refused', 1, true) : recovered(1, 'continue_prompt')
  }
  const revivable = RESUMABLE_STATES.includes(agent.state) || !isTerminalState(agent.state)
  if (revivable && rungAttempts(d.db, v.task.id, d.key.key, 2) < MAX_RESUMES) {
    const r = await ports.resume(agent.id)
    if (r.ok) return reattach(d, v, target) ? recovered(2, 'resumed', true) : escalate('reattach_refused', 2, true)
    if (r.code === 'already_live') return wait('already_live')
    // A refusal (no transcript, too old, worktree gone) or a failed launch is not an end: the clean respawn is the next rung.
    d.note(v, 2, r.code)
  }
  return respawn(d, v, agent)
}

async function climbChat(d: LadderDeps, v: Victim): Promise<Verdict> {
  const { ports } = d
  const a = v.assignment
  if (ports.chatNodeGone(a)) return escalate('node_gone')
  const target = { nodeId: a.nodeId, agentId: null, channel: 'chat' as const }
  if (!v.ended && ports.chatBusy(a.nodeId)) return busy(d, v, target)
  if (rungAttempts(d.db, v.task.id, d.key.key, 1) >= MAX_REPROMPTS) return escalate('limit:reprompt')
  if (v.ended && !reattach(d, v, target)) return escalate('reattach_refused')
  // `chatSend` reopens a session that closed meanwhile; this is not the supervisor's respawn, so `restart_limit` is untouched.
  const sent = await ports.chatSend(a, CONTINUE_PROMPT)
  return sent.ok ? recovered(1, 'continue_prompt') : wait(`chat_send_failed:${sent.code}`, 1, true)
}

async function climbTerminal(d: LadderDeps, v: Victim): Promise<Verdict> {
  const { ports } = d
  const a = v.assignment
  if (!ports.isLive(a.nodeId)) return escalate('terminal_session_gone')
  const target = { nodeId: a.nodeId, agentId: null, channel: 'terminal' as const }
  if (!ports.terminalIdle(a.nodeId)) return busy(d, v, target)
  if (rungAttempts(d.db, v.task.id, d.key.key, 1) >= MAX_REPROMPTS) return escalate('limit:reprompt')
  if (v.ended && !reattach(d, v, target)) return escalate('reattach_refused')
  const sent = await ports.submit(a.nodeId, CONTINUE_PROMPT)
  return sent.ok ? recovered(1, 'continue_prompt') : wait(`submit_failed:${sent.reason}`, 1, true)
}

/** Takes one victim up the ladder as far as its class, its agent and the limits allow; never throws a verdict away. */
export async function climb(d: LadderDeps, v: Victim): Promise<Verdict> {
  // Money and credentials are never retried (workFailureKind): the existing duty / human path owns them.
  if (!isTransientKind(v.kind)) return escalate(`needs_human:${v.kind}`)
  if (d.now() - d.key.window.to > RECOVERY_HORIZON_MS) return escalate('recovery_window_passed')
  const permit = d.ports.permit(v.task.projectId, RECOVER_TOOL)
  if (!permit.ok) return wait(`control:${permit.code}`)
  if (v.assignment.channel === 'spawn') return climbSpawn(d, v)
  return v.assignment.channel === 'chat' ? climbChat(d, v) : climbTerminal(d, v)
}
