// Production `AgentHost` (WS-19): maps the executor's host port onto the worktree service and the
// session port. Everything it runs is server-built: kind -> launch line / argv comes from tables,
// the cwd comes from the worktree allocation, and the prompt never carries free model text.
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import { AGENT_ENVELOPE } from './agentExecutor'
import type { AgentHost } from './agentExecutor'
import type { AgentRecord, AgentRunner } from '../contracts'

/** Worker owner label stored on the worktree allocation. */
export const AGENT_WORKTREE_OWNER = 'central'
/** Branch namespace of central-owned worktrees, so a human can tell and prune them. */
export const AGENT_BRANCH_PREFIX = 'central/'

/** Headless argv builders by kind (P3: opencode headless is the default non-Claude worker). */
const HEADLESS_ARGV: Readonly<Record<string, (prompt: string) => readonly string[]>> = {
  opencode: (prompt) => ['opencode', 'run', prompt],
}

export interface AgentHostDeps {
  sessions: WorkerSessionPort
  worktrees: WorktreeService
  /** Repo path of a project, or null when the project has none (spawn then fails at the worktree stage). */
  repoOf(projectId: string): string | null
  /** Interactive launch line of a kind (settings override or builtin launcher). */
  launchLine(kind: string): string
  /** Optional human-set task title; only server data, never model text. */
  taskTitle?(agent: AgentRecord): string | null
}

/** Builds the host over injected sessions/worktrees (real ones in `ca2Boot`, fakes in tests). */
export function createAgentHost(deps: AgentHostDeps): AgentHost {
  return {
    runnerFor: (kind): AgentRunner => (HEADLESS_ARGV[kind] ? 'exec' : 'pty'),
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
      await deps.sessions.open({ nodeId, cwd, cmd: deps.launchLine(agent.kind), agentId: agent.kind })
    },
    headlessArgv: (kind, prompt) => HEADLESS_ARGV[kind]?.(prompt) ?? null,
    async send(nodeId, text) { deps.sessions.input(nodeId, `${text}\r`) },
    async scrollback(nodeId, lines) { return deps.sessions.getTerminal(nodeId).split('\n').slice(-lines) },
    async closePty(nodeId) { deps.sessions.close(nodeId) },
    hasSession: (nodeId) => deps.sessions.isLive(nodeId),
  }
}
