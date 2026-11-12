// The playbook registry: named tool chains Central runs as ONE tool (`playbook.<id>`), so the chain lives in
// deterministic code instead of the model's memory. Every step is an ordinary registry tool run through
// `execTool` (playbook.run.ts), so guard, audit, approval and checkpoint apply to each step unchanged.
// The instruction text reuses the DAG `Brief` fields (objective, outputFormat, boundaries).
import { type JsonSchema, obj, S } from '../../capability/capability.schema'
import type { Brief } from '../../dag/dag.model'
import type { Tier, ToolInput } from '../tools/toolTypes'

/** Results of earlier steps by `saveAs` name (their `data`). */
export type Saved = Record<string, Record<string, unknown> | undefined>
export type Params = Record<string, string | undefined>

export interface PlaybookStep {
  tool: string
  /** Step input from the playbook params, the saved results and the run id (stable across resumes). */
  args(p: Params, prev: Saved, runId: string): ToolInput
  saveAs?: string
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
  steps: PlaybookStep[]
  brief(p: Params): PlaybookBrief
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

/** Renders a brief as the steer text an agent receives. */
export function renderBrief(b: PlaybookBrief): string {
  return [`Objective: ${b.objective}`, b.instructions, `Output format: ${b.outputFormat}`, `Boundaries: ${b.boundaries}`].join('\n\n')
}

/** The shared chain: board task, then an agent on it, then the brief as its first message. */
function delegate(pb: Omit<Playbook, 'steps'>, role: 'worker' | 'reviewer'): Playbook {
  const named = (p: Params): string => title(pb.label, p[pb.subject] ?? '')
  return {
    ...pb,
    steps: [
      { tool: 'task.create', saveAs: 'task', args: (p) => ({ projectId: p.projectId, title: named(p), objective: renderBrief(pb.brief(p)).slice(0, MAX_OBJECTIVE), acceptance: 'review' }) },
      { tool: 'agent.spawn', saveAs: 'agent', args: (p, prev, runId) => ({ projectId: p.projectId, requestId: `pb-${runId}`, kind: p.kind ?? DEFAULT_AGENT_KIND, role, title: named(p), taskId: prev.task?.taskId }) },
      { tool: 'agent.prompt', saveAs: 'prompt', args: (p, prev) => ({ projectId: p.projectId, agentRef: prev.agent?.agentId, text: renderBrief(pb.brief(p)), mode: 'steer', taskId: prev.task?.taskId }) },
    ],
  }
}

const RESULT_LINE = 'End with a line `RESULT:` followed by'

const webResearch = delegate({
  id: 'web_research', label: 'web research', subject: 'goal', tier: 'R1',
  summary: 'Research the web: a task, an agent with its own cabled browser, a fixed brief; reports RESULT with sources.',
  match: [/\b(analisa|analisis|analy[sz]e|analysis|riset|research|cari(kan)?|bandingkan|compare|trending|investigate|look\s+up|browse|telusuri)\b/i],
  params: obj({ goal: S.str(MAX_GOAL), url: S.str(MAX_GOAL), kind: S.str(100) }, ['goal']), required: ['goal'],
  brief: (p) => ({
    objective: p.goal ?? '',
    instructions: `Open the browser with \`webterm-browser open ${p.url ?? SEARCH_URL + encodeURIComponent(p.goal ?? '')}\`, read the pages with \`webterm-browser snapshot\`, follow the links that matter and gather evidence.`,
    outputFormat: `${RESULT_LINE} markdown: the findings, then a Sources list with every URL you used.`,
    boundaries: 'Read-only research: do not sign in, post, buy or change anything on the web or in the repository.',
  }),
}, 'worker')

const codeChange = delegate({
  id: 'code_change', label: 'code change', subject: 'goal', tier: 'R1',
  summary: 'Change code: a task, a worker agent in its own worktree, a fixed brief; reports RESULT with files and checks.',
  match: [/\b(perbaiki|betulkan|fix|implement\w*|tambah\w*|refactor\w*|ubah|bikin\s+fitur|add\s+(a\s+)?feature)\b/i],
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
  summary: 'Review a PR, branch, diff or path: a task, a reviewer agent, a fixed brief; reports RESULT findings.',
  match: [/\b(review|periksa|cek\s+kode|pull\s+request|PR|diff)\b/i],
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
