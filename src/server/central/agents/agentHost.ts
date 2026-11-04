// Production `AgentHost` (WS-19): maps the executor's host port onto the worktree service and the
// session port. Everything it runs is server-built: kind -> launch line / argv comes from tables,
// the cwd comes from the worktree allocation, and the prompt never carries free model text.
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import { AGENT_ENVELOPE, spawnParentOf } from './agentExecutor'
import type { AgentHost } from './agentExecutor'
import type { AgentRecord, AgentRunner } from '../contracts'
import { AGENT_KIND_UNKNOWN, type AgentCatalog } from './agentCatalog'
import { spawnAgent } from '../../spawn/agentSpawn'

/** Worker owner label stored on the worktree allocation. */
export const AGENT_WORKTREE_OWNER = 'central'
/** Branch namespace of central-owned worktrees, so a human can tell and prune them. */
export const AGENT_BRANCH_PREFIX = 'central/'

export interface AgentHostDeps {
  sessions: WorkerSessionPort
  worktrees: WorktreeService
  /** Repo path of a project, or null when the project has none (spawn then fails at the worktree stage). */
  repoOf(projectId: string): string | null
  /** Kind catalog: launch line, headless argv, tier and env of every spawnable kind. */
  catalog: AgentCatalog
  /** Optional human-set task title; only server data, never model text. */
  taskTitle?(agent: AgentRecord): string | null
  /** The `agent.spawn` path (F2-h); default = the process-wide spawner (depth, caps, lineage, events). */
  spawn?: typeof spawnAgent
}

export { spawnParentOf }

/** Builds the host over injected sessions/worktrees (real ones in `ca2Boot`, fakes in tests). */
export function createAgentHost(deps: AgentHostDeps): AgentHost {
  return {
    runnerFor: (kind): AgentRunner => (deps.catalog.resolve(kind)?.headlessArgv ? 'exec' : 'pty'),
    spawnTier: (kind) => deps.catalog.resolve(kind)?.tier ?? null,
    defHashOf: (kind) => deps.catalog.resolve(kind)?.defHash,
    execEnv: (kind) => deps.catalog.resolve(kind)?.childEnv() ?? {},
    async worktree(agent) {
      const existing = deps.worktrees.get(agent.id)
      if (existing) return existing.path
      const repo = deps.repoOf(agent.projectId)
      if (!repo) throw new Error(`project ${agent.projectId} has no repo path`)
      const allocation = await deps.worktrees.allocate({ taskId: agent.id, branch: `${AGENT_BRANCH_PREFIX}${agent.id}`, repo, owner: AGENT_WORKTREE_OWNER })
      return allocation.path
    },
    async initialPrompt(agent) {
      const title = deps.taskTitle?.(agent)
      const task = agent.taskId ? `Task ${agent.taskId}${title ? `: ${title}` : ''}.` : 'No task attached.'
      return `${AGENT_ENVELOPE}\nRole: ${agent.role}. ${task} Work only inside this worktree; do not merge or push.`
    },
    async openPty(agent, cwd, nodeId) {
      const entry = deps.catalog.resolve(agent.kind)
      if (!entry) throw new Error(`${AGENT_KIND_UNKNOWN}: ${agent.kind}`)
      // ponytail: PTY sessions take no env from the host (OpenMsg has no env field), so `CustomAgent.env` only reaches headless runs.
      const res = await (deps.spawn ?? spawnAgent)(
        { door: 'central', mode: 'pty', kind: agent.kind, parent: spawnParentOf(agent), nodeId, cwd, title: deps.taskTitle?.(agent) ?? `${agent.role} ${agent.kind}`, pty: { cmd: entry.launchLine, agentId: agent.kind } },
        { openPty: () => deps.sessions.open({ nodeId, cwd, cmd: entry.launchLine, agentId: agent.kind }) }
      )
      if (!res.ok) throw new Error(`${res.code}: ${res.message}`)
    },
    headlessArgv: (kind, prompt) => deps.catalog.resolve(kind)?.headlessArgv?.(prompt) ?? null,
    async send(nodeId, text) { deps.sessions.input(nodeId, `${text}\r`) },
    async scrollback(nodeId, lines) { return deps.sessions.getTerminal(nodeId).split('\n').slice(-lines) },
    async closePty(nodeId) { deps.sessions.close(nodeId) },
    hasSession: (nodeId) => deps.sessions.isLive(nodeId),
  }
}
