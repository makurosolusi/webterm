// Production `AgentHost` (WS-19): maps the executor's host port onto the worktree service and the
// session port. Everything it runs is server-built: kind -> launch line / argv comes from tables,
// the cwd comes from the worktree allocation. The boot prompt is a server template plus the stored board
// task (title + objective Central wrote with task.create), passed through the handoff filter.
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import { AGENT_ENVELOPE, agentNodeId, spawnParentOf } from './agentExecutor'
import type { AgentHost } from './agentExecutor'
import type { AgentRecord, AgentRunner } from '../contracts'
import { AGENT_KIND_UNKNOWN, type AgentCatalog } from './agentCatalog'
import { claudeLineWithModel, spawnAgent } from '../../spawn/agentSpawn'
import type { ModelPick } from '../../models/modelLadder'
import { storedPick } from './agentLadder'
import type { CanvasPush } from '../../canvas/canvasPush'
import { filterHandoffContext } from '../../verifier/handoff.filter'
import { joinArgv } from '../../../shared/claudeLaunch/shellQuote'
import { resumeTurnPrefix } from '../../agentEnv'
import { agentSessionId, ensureAgentNode } from './agentCanvas'

const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g

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
  /** The board task the agent was started on (title + objective, as stored by task.create); null = none or not found. */
  task?(agent: AgentRecord): { title: string; objective: string } | null
  /** The `agent.spawn` path (F2-h); default = the process-wide spawner (depth, caps, lineage, events). */
  spawn?: typeof spawnAgent
  /** Board writer: a PTY agent is added as a canvas node; absent = no node (tests, headless boot). */
  canvas?: CanvasPush
}

export { spawnParentOf }

/** Builds the host over injected sessions/worktrees (real ones in `ca2Boot`, fakes in tests). */
export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const taskOf = (agent: AgentRecord) => (agent.taskId ? deps.task?.(agent) ?? null : null)
  const titleOf = (agent: AgentRecord): string => taskOf(agent)?.title ?? `${agent.role} ${agent.kind}`
  /** The first message carries everything: who it is, where, the task, and how its result reaches Central. */
  const initialPrompt = (agent: AgentRecord): string => {
    const where = `You are a ${agent.role} agent started by webterm Central (agent ${agent.id}, canvas node ${agentNodeId(agent.id)}, project ${agent.projectId}).`
    const rules = 'Work only inside this worktree; do not merge or push.'
    if (!agent.taskId) return `${AGENT_ENVELOPE}\n${where} No task attached yet: reply only READY and wait; Central sends the task as your next message. ${rules}`
    const task = taskOf(agent)
    return [`${AGENT_ENVELOPE}`, where, `Task ${agent.taskId}${task ? `: ${task.title}` : ''}.`, ...(task?.objective ? [task.objective.replace(CONTROL_CHARS, '')] : []),
      `When you finish, end your final message with a line starting \`RESULT:\` followed by your result. webterm captures that message and reports it to Central automatically, so do not wait for a reply. If you are blocked or need a decision, say so and stop; that reaches Central too.`,
      'To report at any time (progress, blocked, a question, or done with your result), run `webterm report "<text>" --progress|--blocked|--question|--done`.',
      rules].join('\n')
  }
  const place = (agent: AgentRecord, nodeId: string, cwd: string, cmd: string): void =>
    ensureAgentNode(deps.canvas, deps.repoOf(agent.projectId), { agent, nodeId, cwd, cmd, title: titleOf(agent) })
  /** Opens the agent's PTY; `resumeMaxAgeMs` set = relaunch its saved conversation (`--resume`, same flags via `launchLine`) and continue the cut-off turn. */
  const launchPty = async (agent: AgentRecord, cwd: string, nodeId: string, resumeMaxAgeMs?: number, given?: ModelPick | null): Promise<void> => {
    const entry = deps.catalog.resolve(agent.kind)
    if (!entry) throw new Error(`${AGENT_KIND_UNKNOWN}: ${agent.kind}`)
    // ponytail: PTY sessions take no env from the host (OpenMsg has no env field), so `CustomAgent.env` only reaches headless runs.
    // A session id makes `launchLine` add the hook `--settings` (same as a canvas/control claude node).
    const sessionId = agentSessionId(agent)
    const resuming = resumeMaxAgeMs !== undefined
    // The ladder's model rides the claude line; a resume reuses the stored decision, so the model never changes mid-task.
    const pick = given ?? storedPick(agent)
    const line = claudeLineWithModel(entry.launchLine, pick)
    // A resumed claude takes no positional prompt: the CLI continues the cut-off turn itself.
    // Otherwise builtin claude takes its task as the positional prompt; only the PTY gets it, the node keeps the plain line.
    const cmd = resuming ? `${resumeTurnPrefix(resumeMaxAgeMs)} ${line}` : entry.builtin ? `${line} ${joinArgv([filterHandoffContext(initialPrompt(agent)).replace(/\s*\n\s*/g, ' ')])}` : line
    const open = { nodeId, cwd, cmd, agentId: agent.kind, ...(pick ? { pick } : {}), ...(sessionId ? { sessionId } : {}), ...(resuming ? { resume: true } : {}) }
    const res = await (deps.spawn ?? spawnAgent)(
      { door: 'central', mode: 'pty', kind: agent.kind, parent: spawnParentOf(agent), nodeId, cwd, title: titleOf(agent), pty: open },
      { openPty: () => deps.sessions.open(open) }
    )
    if (!res.ok) throw new Error(`${res.code}: ${res.message}`)
    place(agent, nodeId, cwd, line)
  }
  return {
    runnerFor: (kind): AgentRunner => (deps.catalog.resolve(kind)?.headlessArgv ? 'exec' : 'pty'),
    spawnTier: (kind) => deps.catalog.resolve(kind)?.tier ?? null,
    defHashOf: (kind) => deps.catalog.resolve(kind)?.defHash,
    worktreeOf: (agent) => deps.worktrees.get(agent.id)?.path ?? null,
    execEnv: (kind) => deps.catalog.resolve(kind)?.childEnv() ?? {},
    async worktree(agent) {
      const existing = deps.worktrees.get(agent.id)
      if (existing) return existing.path
      const repo = deps.repoOf(agent.projectId)
      if (!repo) throw new Error(`project ${agent.projectId} has no repo path`)
      const allocation = await deps.worktrees.allocate({ taskId: agent.id, branch: `${AGENT_BRANCH_PREFIX}${agent.id}`, repo, owner: AGENT_WORKTREE_OWNER })
      return allocation.path
    },
    initialPrompt: async (agent) => initialPrompt(agent),
    openPty: (agent, cwd, nodeId, pick) => launchPty(agent, cwd, nodeId, undefined, pick),
    resumePty: (agent, cwd, nodeId, maxAgeMs) => launchPty(agent, cwd, nodeId, maxAgeMs),
    ensureNode(agent, nodeId) {
      const cwd = deps.worktrees.get(agent.id)?.path
      const entry = deps.catalog.resolve(agent.kind)
      if (cwd && entry) place(agent, nodeId, cwd, claudeLineWithModel(entry.launchLine, storedPick(agent)))
    },
    headlessArgv: (kind, prompt) => deps.catalog.resolve(kind)?.headlessArgv?.(prompt) ?? null,
    send: (nodeId, text) => deps.sessions.submit(nodeId, text),
    async scrollback(nodeId, lines) { return deps.sessions.getTerminal(nodeId).split('\n').slice(-lines) },
    async closePty(nodeId) { deps.sessions.close(nodeId) },
    hasSession: (nodeId) => deps.sessions.isLive(nodeId),
  }
}
