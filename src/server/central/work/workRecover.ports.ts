// Production adapters of the recovery ladder: they go through the same doors Central's own tools use (the control
// guard, the agent executor's spawn and prompt, the agent store's typed revive), never around them.
import type { Database } from 'bun:sqlite'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import { createLogger } from '../../logs'
import { agentNodeId, type AgentExecutor, type AgentHost } from '../agents/agentExecutor'
import { RESUME_MAX_AGE_MS, repromptContinue, resumeAgent, type ResumeDeps } from '../agents/agentSessionResume'
import { RESUMABLE_STATES } from '../agents/agentStateMachine'
import { createAgentStore } from '../agents/agentStore'
import type { SyncControlGuard } from '../guard/controlGuard'
import type { AgentInfo, RecoverPorts } from './workRecover.model'
import type { WorkSupervisorPorts } from './workSupervisor'

const log = createLogger('central.work')

/** What the ladder needs from the CA2 boot; absent while agents are off (then only chat and terminal work can be recovered). */
export interface RecoverRuntime {
  executor: AgentExecutor | null
  host: AgentHost | null
  guard: Pick<SyncControlGuard, 'check'>
  /** Mode `propose`: a respawn waits for a human approval card, like a model-requested spawn does. */
  requireApproval: boolean
}

export interface RecoverPortsDeps {
  db: Database
  now(): number
  base: WorkSupervisorPorts
  sessions: Pick<WorkerSessionPort, 'statusOf'>
  runtime(): RecoverRuntime | null
  /** Test seam: where the saved conversation and the worktree are looked up (default: the real disk). */
  probes?: Pick<ResumeDeps, 'transcript' | 'dirExists'>
}

/** Wires the ladder's world to the real services. */
export function createRecoverPorts({ db, now, base, sessions, runtime, probes }: RecoverPortsDeps): RecoverPorts {
  const agents = createAgentStore(db, now)
  const info = (id: string): AgentInfo | null => {
    const a = agents.get(id)
    return a ? { id: a.id, state: a.state, runner: a.runner, kind: a.kind, role: a.role, owner: a.owner, nodeId: a.nodeId } : null
  }
  return {
    isLive: base.isLive, submit: base.submit, chatBusy: base.chatBusy, chatNodeGone: base.chatNodeGone, chatSend: base.chatSend,
    agent: info,
    terminalIdle: (nodeId) => sessions.statusOf(nodeId) !== 'working',
    permit(projectId, tool) {
      const rt = runtime()
      if (!rt) return { ok: false, code: 'central_off' }
      const d = rt.guard.check({ action: 'tool', projectId, tool, tier: 'R1' })
      if (d.verdict === 'allow') return { ok: true }
      return { ok: false, code: d.verdict === 'deny' ? d.code : 'needs_approval' }
    },
    async reprompt(agentId) {
      const rt = runtime()
      return rt?.executor ? repromptContinue({ store: rt.executor.store, executor: rt.executor }, agentId) : { ok: false, code: 'agents_off' }
    },
    async resume(agentId) {
      const rt = runtime()
      if (!rt?.executor || !rt.host) return { ok: false, code: 'agents_off' }
      const r = await resumeAgent({ store: rt.executor.store, host: rt.host, now, ...probes }, agentId, { maxAgeMs: RESUME_MAX_AGE_MS })
      if (!r.ok) return { ok: false, code: r.code }
      const row = agents.get(agentId)
      if (row && RESUMABLE_STATES.includes(row.state)) {
        try { agents.revive(agentId) } catch (err) {
          // The process is already running again: failing here would make the ladder start a second agent, so it is reported and kept.
          log.error('work.recover_revive_failed', `agent ${agentId} resumed but its row could not be revived`, { agentId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return { ok: true }
    },
    async respawn(input) {
      const rt = runtime()
      if (!rt?.executor) return { ok: false, code: 'agents_off' }
      const r = await rt.executor.spawn({ ...input, requireApproval: rt.requireApproval })
      const agentId = r.data?.agentId
      if (!r.ok || typeof agentId !== 'string') return { ok: false, code: r.code ?? 'spawn_failed' }
      return { ok: true, agentId, nodeId: typeof r.data?.nodeId === 'string' ? r.data.nodeId : agentNodeId(agentId) }
    },
    async brief(agentId, text) {
      const rt = runtime()
      const agent = rt?.executor?.store.get(agentId)
      return rt?.executor && agent ? (await rt.executor.prompt(agent, text, 'steer')).ok : false
    },
  }
}
