// Plan drafting (F4-f): an intent typed in ⌘K becomes a DAG DRAFT, never a running DAG. Jules-style
// plan approval: the planner only reads the repo, the draft is shown on the canvas as a Plan node,
// and only a human `POST /api/dag` turns it into work.
//
// The planner is headless Claude Code (`claude -p`) with structured output: `--json-schema` makes the
// final result conform and lands it in `structured_output` (code.claude.com/docs/en/headless, "Get
// structured output"). `--tools Read,Grep,Glob` removes every tool that could write or run commands,
// so drafting cannot change code whatever the model decides. The draft is then validated by the same
// `validateTasks` the DAG API applies, so a bad draft fails here and not at approval.
import type { ExecOutcome } from '../central/agents/execRunner'
import { DEFAULT_EXECUTABLES } from '../orchestrator/verifyCommands'
import { claudeHeadlessArgv, spawnAgent } from '../spawn/agentSpawn'
import { activeProviderEnv } from '../claudeProvider/claudeProvider.store'
import { applyProviderEnv } from '../claudeProvider/claudeProvider.model'
import { DAG_MAX_TASKS, DagError, EFFORT_SCALE, validateTasks, type Brief, type DagTaskKind } from './dag.model'
import { DAG_PARENT } from './dag.scheduler'

export const PLANNER_TIMEOUT_MS = 5 * 60_000
export const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'] as const
export const INTENT_MAX = 2000
const TITLE_MAX = 200

export interface PlanDraft { title: string; tasks: Array<{ key: string; kind: DagTaskKind; deps: string[]; brief: Brief }> }

/** Drafts a plan for `intent` in `repo`; resolves to the planner's raw structured output. */
export type Planner = (input: { intent: string; repo: string }) => Promise<unknown>

const str = { type: 'string' } as const
const strs = { type: 'array', items: str } as const

/** Strict schema of the planner's answer; mirrors `validateBrief` (gate tasks fill only objective/nextAction). */
export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'tasks'],
  properties: {
    title: str,
    tasks: {
      type: 'array', minItems: 1, maxItems: DAG_MAX_TASKS,
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'kind', 'deps', 'brief'],
        properties: {
          key: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
          kind: { enum: ['work', 'gate'] },
          deps: strs,
          brief: {
            type: 'object', additionalProperties: false, required: ['objective', 'nextAction'],
            properties: {
              objective: str, outputFormat: str, tools: strs, boundaries: str, nextAction: str,
              effort: { enum: Object.keys(EFFORT_SCALE) }, lease: strs, options: strs,
              verifyCmd: { type: 'object', additionalProperties: false, required: ['file', 'args'], properties: { file: { enum: [...DEFAULT_EXECUTABLES] }, args: strs } },
            },
          },
        },
      },
    },
  },
} as const

export function plannerPrompt(intent: string): string {
  return [
    'You are the webterm planner. Draft a task DAG for the intent below. Do NOT change any file: read the repository only to plan.',
    `Intent: ${intent}`,
    'Rules:',
    '- Split the work into the fewest tasks that can be verified on their own; keys are short slugs (e.g. "api", "ui-form").',
    '- Every work task has a brief: objective, outputFormat, tools (Claude Code tool names, e.g. Read, Edit, Write, Bash(npm test *)), boundaries, nextAction, effort (simple|moderate|complex) and lease.',
    '- lease = the relative paths the task may change ("src/api/**"). Tasks with overlapping leases never run in parallel, so keep leases narrow and disjoint where possible.',
    `- verifyCmd = argv that proves the task is done, executable one of ${DEFAULT_EXECUTABLES.join(', ')} (e.g. {"file":"npm","args":["test"]}).`,
    '- deps = keys of tasks that must finish first.',
    '- Add a task with kind "gate" (objective = the question, options = the choices, nextAction) wherever a human must decide before work continues; gates are human-only.',
    'Answer with the structured output only.',
  ].join('\n')
}

export function plannerArgv(intent: string): string[] {
  return [
    ...claudeHeadlessArgv(plannerPrompt(intent)), '--json-schema', JSON.stringify(PLAN_SCHEMA),
    '--tools', PLANNER_TOOLS.join(','), '--allowedTools', PLANNER_TOOLS.join(','), '--permission-mode', 'dontAsk',
  ]
}

/** The planner's structured output from a finished `claude -p --output-format json` run. */
export function plannerOutput(o: ExecOutcome): unknown {
  if (o.timedOut) throw new Error(`planner timed out after ${PLANNER_TIMEOUT_MS / 1000}s`)
  const ev = o.lastEvent
  if (ev && ev['structured_output'] !== undefined) return ev['structured_output']
  const why = ev && typeof ev['result'] === 'string' ? ev['result'] : o.error ?? `exit ${o.exitCode}`
  throw new Error(`planner returned no structured output: ${String(why).slice(0, 300)}`)
}

/** Validates a raw draft exactly like `POST /api/dag` would; throws `DagError`. */
export function validateDraft(raw: unknown): PlanDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DagError('invalid_draft', 'draft must be an object')
  const { title, tasks } = raw as { title?: unknown; tasks?: unknown }
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) throw new DagError('invalid_title', `title: 1..${TITLE_MAX} chars`)
  return { title: title.trim(), tasks: validateTasks(tasks) }
}

/** Production planner: one headless Claude Code run under Central's lineage in the workspace folder. */
export const livePlanner: Planner = async ({ intent, repo }) => {
  // Claude provider: the exec scrub keeps only an allowlist, so the provider vars ride as overrides.
  const pe = activeProviderEnv()
  const res = await spawnAgent({
    mode: 'headless', door: 'central', parent: DAG_PARENT, cwd: repo, title: 'Plan draft', prompt: plannerPrompt(intent),
    headless: { argv: plannerArgv(intent), timeoutMs: PLANNER_TIMEOUT_MS, env: applyProviderEnv(process.env, { set: {}, unset: pe.unset }), overrides: pe.set },
  })
  if (!res.ok || !res.handle) throw new Error(`planner spawn failed: ${res.ok ? 'no process handle' : res.message}`)
  return plannerOutput(await res.handle.done)
}
