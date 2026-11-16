// The playbook registry: named tool chains Central runs as ONE tool (`playbook.<id>`), so the chain lives in
// deterministic code instead of the model's memory. Every step is an ordinary registry tool run through
// `execTool` (playbook.run.ts), so guard, audit, approval and checkpoint apply to each step unchanged.
// The instruction text reuses the DAG `Brief` fields (objective, outputFormat, boundaries).
import { type JsonSchema, obj, S } from '../../capability/capability.schema'
import type { Brief } from '../../dag/dag.model'
import type { Complexity } from '../agents/agentLadder'
import type { Tier, ToolInput } from '../tools/toolTypes'
import { CODE_CHANGE_WORDS, REVIEW_WORDS, WEB_RESEARCH_WORDS } from './playbook.intentWords'

/** Results of earlier steps by `saveAs` name (their `data`). */
export type Saved = Record<string, Record<string, unknown> | undefined>
export type Params = Record<string, string | undefined>

export interface PlaybookStep {
  tool: string
  /** Step input from the playbook params, the saved results and the run id (stable across resumes). */
  args(p: Params, prev: Saved, runId: string): ToolInput
  saveAs?: string
  /** A failure is saved under `saveAs` as `{ error }` and the chain goes on (a convenience the agent can do itself). */
  optional?: boolean
  /** Runs only once the spawned agent is active (an approved spawn may still be provisioning). */
  needsAgent?: boolean
}

export type PlaybookBrief = Pick<Brief, 'objective' | 'outputFormat' | 'boundaries'> & { instructions: string }

export interface Playbook {
  id: string
  summary: string
  /** Words that suggest this playbook in a human message (context/playbookHint.ts). */
  match: RegExp[]
  /** Input schema WITHOUT projectId (added for project-scoped tools). */
  params: JsonSchema
  required: readonly string[]
  tier: Tier
  /** What the user is told when it starts, e.g. "web research". */
  label: string
  /** The param the notice and task title name. */
  subject: string
  /** How hard the spawned agent's task honestly is; sets its model (agent.spawn `complexity`). */
  complexity: Complexity
  steps: PlaybookStep[]
  /** `runId` names what the run sets up for the agent (its browser node); `browserNode` overrides it with an existing one (a reused agent's). */
  brief(p: Params, runId: string, browserNode?: string): PlaybookBrief
}

const MAX_GOAL = 2000
const MAX_TITLE = 200
/** task.create objective cap. */
const MAX_OBJECTIVE = 8000
/** Agent kind used when the call names none; the built-in Claude Code worker. */
export const DEFAULT_AGENT_KIND = 'claude'
/** Search page an agent opens when the goal names no URL. */
export const SEARCH_URL = 'https://duckduckgo.com/?q='

const title = (label: string, text: string): string => `${label}: ${text.replace(/\s+/g, ' ').trim()}`.slice(0, MAX_TITLE)

/** Browser node a web_research run opens and cables to its agent; fixed per run so the brief can name it before it exists. */
export const browserNodeOf = (runId: string): string => `br-${runId}`

/** Renders a brief as the task objective, which the agent receives as its first message. */
export function renderBrief(b: PlaybookBrief): string {
  return [`Objective: ${b.objective}`, b.instructions, `Output format: ${b.outputFormat}`, `Boundaries: ${b.boundaries}`].join('\n\n')
}

/**
 * The shared chain: the board task holds the brief as its objective, and the agent spawned on it gets that brief in its
 * FIRST message (agentHost boot prompt), so nothing is sent after it. `extra` steps run after the spawn.
 */
function delegate(pb: Omit<Playbook, 'steps'>, role: 'worker' | 'reviewer', extra: PlaybookStep[] = []): Playbook {
  const named = (p: Params): string => title(pb.label, p[pb.subject] ?? '')
  return {
    ...pb,
    steps: [
      { tool: 'task.create', saveAs: 'task', args: (p, prev, runId) => ({ projectId: p.projectId, title: named(p), objective: renderBrief(pb.brief(p, runId, (prev.reuse?.browserNodeId as string | undefined))).slice(0, MAX_OBJECTIVE), acceptance: 'review' }) },
      { tool: 'agent.spawn', saveAs: 'agent', args: (p, prev, runId) => ({ projectId: p.projectId, requestId: `pb-${runId}`, kind: p.kind ?? DEFAULT_AGENT_KIND, role, title: named(p), taskId: prev.task?.taskId, complexity: pb.complexity }) },
      ...extra,
    ],
  }
}

const RESULT_LINE = 'End with a line `RESULT:` followed by'

const webResearch = delegate({
  id: 'web_research', label: 'web research', subject: 'goal', tier: 'R1',
  // Reading a repo or pages and judging them needs reasoning, not the strongest model.
  complexity: 'moderate',
  summary: 'Research the web: a task, an agent with its own cabled browser, a fixed brief; reports RESULT with sources.',
  match: [WEB_RESEARCH_WORDS],
  params: obj({ goal: S.str(MAX_GOAL), url: S.str(MAX_GOAL), kind: S.str(100) }, ['goal']), required: ['goal'],
  brief: (p, runId, browserNode) => ({
    objective: p.goal ?? '',
    instructions: `webterm opens browser node ${browserNode ?? browserNodeOf(runId)} beside you, cabled to you. Go to ${p.url ?? SEARCH_URL + encodeURIComponent(p.goal ?? '')} with \`webterm-browser navigate <url>\` (no --node needed while it is your only cabled browser; if none is cabled yet, \`webterm-browser open <url>\` opens one), read the pages with \`webterm-browser snapshot\`, follow the links that matter and gather evidence.`,
    outputFormat: `${RESULT_LINE} markdown: the findings, then a Sources list with every URL you used.`,
    boundaries: 'Read-only research: do not sign in, post, buy or change anything on the web or in the repository.',
  }),
}, 'worker', [
  // Cabled right after the spawn, before the agent's first tool call; without browser tools the agent opens its own.
  { tool: 'browser_open', saveAs: 'browser', optional: true, needsAgent: true, args: (p, prev, runId) => ({ projectId: p.projectId, agentRef: prev.agent?.agentId, nodeId: browserNodeOf(runId) }) },
])

const codeChange = delegate({
  id: 'code_change', label: 'code change', subject: 'goal', tier: 'R1',
  // The scope is unknown up front; Central passes `complex` itself via agent.spawn for multi-file work.
  complexity: 'moderate',
  summary: 'Change code: a task, a worker agent in its own worktree, a fixed brief; reports RESULT with files and checks.',
  match: [CODE_CHANGE_WORDS],
  params: obj({ goal: S.str(MAX_GOAL), kind: S.str(100) }, ['goal']), required: ['goal'],
  brief: (p) => ({
    objective: p.goal ?? '',
    instructions: 'Read the code involved first, make the smallest change that does it, add or update a test, and run the project checks.',
    outputFormat: `${RESULT_LINE} markdown: what changed and why, the files touched, the checks you ran and their result.`,
    boundaries: 'Work only in your worktree; do not push, merge or deploy; ask before deleting files.',
  }),
}, 'worker')

const review = delegate({
  id: 'review', label: 'review', subject: 'target', tier: 'R1',
  complexity: 'moderate',
  summary: 'Review a PR, branch, diff or path: a task, a reviewer agent, a fixed brief; reports RESULT findings.',
  match: [REVIEW_WORDS],
  params: obj({ target: S.str(MAX_GOAL), kind: S.str(100) }, ['target']), required: ['target'],
  brief: (p) => ({
    objective: `Review ${p.target ?? ''}`,
    instructions: 'Read the change and the code around it; look for bugs, missing tests and risky edges before style.',
    outputFormat: `${RESULT_LINE} markdown: findings worst first, each with file:line and a suggested fix; say so when nothing is wrong.`,
    boundaries: 'Read only: do not change, commit or push anything.',
  }),
}, 'reviewer')

/** Every playbook; the order is the hint's match priority (most specific first). */
export const PLAYBOOKS: readonly Playbook[] = [review, codeChange, webResearch]

export const playbookTool = (id: string): string => `playbook.${id}`
export const playbookById = (id: string): Playbook | undefined => PLAYBOOKS.find((p) => p.id === id)
