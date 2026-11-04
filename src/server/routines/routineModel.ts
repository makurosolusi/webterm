// Routines (PLAN/02-fase.md F4-a): types, input validation, tier and templates. Pure (vitest-safe).
//
// Imitated:
// - Claude Code routines (code.claude.com/docs/en/routines): one saved config (prompt + repo) fired
//   by Schedule, API (POST) or an event trigger.
// - Claude Code Desktop scheduled tasks (code.claude.com/docs/en/desktop-scheduled-tasks): after the
//   machine slept only ONE catch-up run for the most recent missed slot within 7 days; history keeps
//   skipped runs with the reason.
// - Orca automations (`src/shared/automations-types.ts:9-19`, `src/shared/automation-precheck.ts`):
//   explicit skip statuses, and a shell precheck with a bounded timeout that decides "no work"
//   before any agent is spawned (zero tokens).
import { isKindPattern } from '../events/eventBus'
import { cronError } from './routineCron'

export type Tier = 'R0' | 'R1' | 'R2' | 'R3'

export type RoutineTrigger =
  | { type: 'schedule'; cron: string }
  | { type: 'event'; pattern: string; debounceMs?: number }
  | { type: 'api' }

export type RoutineAction =
  | { type: 'spawn'; prompt: string }
  | { type: 'outbox'; to: string; body: string }
  /** PR review bot (prreview.service.ts): review open PRs with a new head, drafts land in the Inbox. */
  | { type: 'prreview' }

export interface RoutinePrecheck { command: string; timeoutSeconds: number }
export interface RoutineBudget { maxRunsPerDay: number; maxCostUsdPerDay: number | null }

export interface RoutineInput {
  name: string
  enabled: boolean
  workspaceId: string | null
  trigger: RoutineTrigger
  precheck: RoutinePrecheck | null
  action: RoutineAction
  budget: RoutineBudget
}

export interface Routine extends RoutineInput {
  id: string
  /** Next scheduled slot (schedule triggers only). */
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

/** How a run started; `catch_up` = the one collapsed run for slots missed while asleep. */
export type RunTrigger = 'schedule' | 'catch_up' | 'event' | 'api' | 'manual'
export type RunStatus = 'running' | 'ran' | 'skipped' | 'failed'
export type SkipReason = 'precheck' | 'missed' | 'busy' | 'budget' | 'untrusted_event' | 'no_cwd'

export interface RoutineRun {
  id: string
  routineId: string
  trigger: RunTrigger
  status: RunStatus
  reason: string | null
  scheduledFor: number | null
  startedAt: number
  finishedAt: number | null
  costUsd: number | null
  /** Cost-oracle median of past runs at start, USD; null = no history. */
  estimateUsd: number | null
  inboxItemId: string | null
  childId: string | null
}

export const PRECHECK_TIMEOUT_DEFAULT_S = 60
export const PRECHECK_TIMEOUT_MAX_S = 600
export const EVENT_DEBOUNCE_DEFAULT_MS = 5000
export const EVENT_DEBOUNCE_MAX_MS = 3_600_000
export const BUDGET_RUNS_DEFAULT = 24
/** Claude Code Desktop: missed runs older than this are skipped, never caught up. */
export const CATCH_UP_WINDOW_MS = 7 * 86_400_000
const NAME_MAX = 120
const TEXT_MAX = 32 * 1024
const COMMAND_MAX = 4096
const NODE_ID_RE = /^[\w.:-]{1,200}$/

/** spawn and prreview = `agent.spawn` (R2; prreview posts nothing by itself); typing into a wired agent's outbox is R1. */
export function routineTier(action: RoutineAction): Tier {
  return action.type === 'outbox' ? 'R1' : 'R2'
}

const TIER_RANK: Record<Tier, number> = { R0: 0, R1: 1, R2: 2, R3: 3 }
/** PLAN F4 exit rule: an `untrusted` event never fires a routine at R2 or above. */
export const untrustedMayFire = (tier: Tier): boolean => TIER_RANK[tier] < TIER_RANK.R2

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null)

function parseTrigger(v: unknown): RoutineTrigger | string {
  if (!isObj(v)) return 'trigger must be an object'
  if (v.type === 'schedule') {
    const cron = str(v.cron, 200)
    if (!cron) return 'trigger.cron is required'
    const err = cronError(cron)
    return err ?? { type: 'schedule', cron: cron.trim() }
  }
  if (v.type === 'event') {
    const pattern = str(v.pattern, 200)
    if (!pattern || !isKindPattern(pattern)) return 'trigger.pattern must be an event kind pattern like hook.Stop or fs.*'
    if (pattern === '*' || pattern.startsWith('routine.')) return 'trigger.pattern may not match every event or routine events'
    const d = v.debounceMs === undefined ? EVENT_DEBOUNCE_DEFAULT_MS : Number(v.debounceMs)
    if (!Number.isInteger(d) || d < 0 || d > EVENT_DEBOUNCE_MAX_MS) return 'trigger.debounceMs out of range'
    return { type: 'event', pattern, debounceMs: d }
  }
  if (v.type === 'api') return { type: 'api' }
  return 'trigger.type must be schedule, event or api'
}

function parseAction(v: unknown): RoutineAction | string {
  if (!isObj(v)) return 'action must be an object'
  if (v.type === 'spawn') {
    const prompt = str(v.prompt, TEXT_MAX)
    return prompt ? { type: 'spawn', prompt } : 'action.prompt is required'
  }
  if (v.type === 'outbox') {
    const to = str(v.to, 200)
    const body = str(v.body, TEXT_MAX)
    if (!to || !NODE_ID_RE.test(to)) return 'action.to must be a node id'
    return body ? { type: 'outbox', to, body } : 'action.body is required'
  }
  if (v.type === 'prreview') return { type: 'prreview' }
  return 'action.type must be spawn, outbox or prreview'
}

/** Validates an API body into a routine definition; a string is the 400 reason. */
export function parseRoutineInput(v: unknown): RoutineInput | string {
  if (!isObj(v)) return 'body must be an object'
  const name = str(v.name, NAME_MAX)
  if (!name) return `name is required (max ${NAME_MAX} chars)`
  const trigger = parseTrigger(v.trigger)
  if (typeof trigger === 'string') return trigger
  const action = parseAction(v.action)
  if (typeof action === 'string') return action
  let precheck: RoutinePrecheck | null = null
  if (isObj(v.precheck) && typeof v.precheck.command === 'string' && v.precheck.command.trim() !== '') {
    const command = v.precheck.command.trim()
    if (command.length > COMMAND_MAX) return 'precheck.command too long'
    const t = v.precheck.timeoutSeconds === undefined ? PRECHECK_TIMEOUT_DEFAULT_S : Number(v.precheck.timeoutSeconds)
    if (!Number.isInteger(t) || t < 1 || t > PRECHECK_TIMEOUT_MAX_S) return `precheck.timeoutSeconds must be 1-${PRECHECK_TIMEOUT_MAX_S}`
    precheck = { command, timeoutSeconds: t }
  }
  const b = isObj(v.budget) ? v.budget : {}
  const runs = b.maxRunsPerDay === undefined ? BUDGET_RUNS_DEFAULT : Number(b.maxRunsPerDay)
  if (!Number.isInteger(runs) || runs < 1 || runs > 1440) return 'budget.maxRunsPerDay must be 1-1440'
  const cost = b.maxCostUsdPerDay === undefined || b.maxCostUsdPerDay === null ? null : Number(b.maxCostUsdPerDay)
  if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) return 'budget.maxCostUsdPerDay must be a positive number'
  const workspaceId = v.workspaceId === undefined || v.workspaceId === null || v.workspaceId === '' ? null : str(v.workspaceId, 200)
  if (v.workspaceId && !workspaceId) return 'workspaceId must be a string'
  return { name: name.trim(), enabled: v.enabled !== false, workspaceId, trigger, precheck, action, budget: { maxRunsPerDay: runs, maxCostUsdPerDay: cost } }
}

export interface RoutineTemplate { id: string; name: string; description: string; input: Omit<RoutineInput, 'workspaceId' | 'enabled'> }

/** Starter routines shown in the panel (Copilot's weekly "find missing tests" automation et al.). */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'weekly-missing-tests', name: 'Weekly: find missing tests',
    description: 'Every Monday 09:00, if the repo has commits from the last week, ask Claude for untested code and proposed tests.',
    input: {
      name: 'Weekly: find missing tests',
      trigger: { type: 'schedule', cron: '0 9 * * 1' },
      precheck: { command: 'test -n "$(git log --since=7.days --oneline 2>/dev/null)"', timeoutSeconds: 30 },
      action: { type: 'spawn', prompt: 'Find code changed in the last 7 days that has no tests. List each gap with the file and a proposed test. Do not edit files; report only.' },
      budget: { maxRunsPerDay: 1, maxCostUsdPerDay: 2 },
    },
  },
  {
    id: 'nightly-failing-tests', name: 'Nightly: explain failing tests',
    description: 'Every night at 02:00, only when the test suite fails, ask Claude for the root cause.',
    input: {
      name: 'Nightly: explain failing tests',
      trigger: { type: 'schedule', cron: '0 2 * * *' },
      precheck: { command: '! npm test --silent >/dev/null 2>&1', timeoutSeconds: 600 },
      action: { type: 'spawn', prompt: 'The test suite is failing. Run it, find the root cause of each failure and report it with the file and line. Do not edit files.' },
      budget: { maxRunsPerDay: 1, maxCostUsdPerDay: 2 },
    },
  },
  {
    id: 'review-uncommitted', name: 'Review uncommitted changes when an agent stops',
    description: 'When a Claude session stops and the working tree is dirty, ask for a short review.',
    input: {
      name: 'Review uncommitted changes',
      trigger: { type: 'event', pattern: 'hook.Stop', debounceMs: 30_000 },
      precheck: { command: '! git diff --quiet', timeoutSeconds: 30 },
      action: { type: 'spawn', prompt: 'Review the uncommitted diff (git diff). Report bugs and risky changes briefly. Do not edit files.' },
      budget: { maxRunsPerDay: 10, maxCostUsdPerDay: 3 },
    },
  },
]
