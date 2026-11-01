// HTTP surface for ONE production worker run: POST /api/orchestrator/run.
// The request only names a project/item and a plan version. Repo, command, agent and exec are
// resolved SERVER-SIDE (project.path + settings), never taken from the payload: a run spawns a
// real PTY, so a client-supplied repo/cmd would be remote command execution.
//
// The route does not create tasks/agents/plans. An item must already be `assigned` by the
// orchestrator (assign flow); otherwise this answers 409 `not_assigned` and touches nothing.
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { createPlanStore, type PlanStore } from './orchestrator/plan'
import { createWorktreeService, type Exec, type WorktreeService } from './orchestrator/worktree'
import {
  createSessionsPort,
  createWorkerRuntime,
  type WorkerRuntime,
  type WorkerRunInput,
  type WorkerRunOutcome,
  type WorkerSessionPort,
} from './orchestrator/workerRuntime'
import { contextOf } from './orchestrator/orchestratorSupport'
import { recordWorkerResult, startWorker } from './orchestrator/orchestratorRun'
import { verifyWorktree, type VerifyInput, type VerifyOutcome } from './orchestrator/verify'
import { createProcessExec } from './orchestrator/verifier'
import { dataDir } from './config'

export type RouteResult = { status: number; body: unknown }

export const ORCHESTRATOR_RUN_FLAG = 'WEBTERM_ORCHESTRATOR_RUN'
export const ORCHESTRATOR_RUN_PATH = '/api/orchestrator/run'

const DEFAULT_AGENT_ID = 'claude'
const DEFAULT_AGENT_CMD = 'claude'
const MAX_ID_CHARS = 200
const MAX_PROMPT_CHARS = 2000
const MAX_BASE_REF_CHARS = 200
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 15 * 60_000
const GIT_TIMEOUT_MS = 120_000
const GIT_OUTPUT_BYTES = 256 * 1024

/** Fields that would let a client choose WHAT runs or WHERE. Rejected outright. */
const CLIENT_CONTROLLED_FIELDS = [
  'repo',
  'path',
  'cwd',
  'cmd',
  'command',
  'args',
  'argv',
  'exec',
  'env',
  'shell',
  'agent',
  'agentId',
] as const

export interface RuntimeCompose {
  root: string
  repo: string
  cmd: string
  plan: Pick<PlanStore, 'get'>
  worktrees: WorktreeService
}

export interface OrchestratorRunDeps {
  ledger: LedgerRuntime | null
  /** Defaults to the `WEBTERM_ORCHESTRATOR_RUN` flag; tests may pin it. */
  enabled?: boolean
  /** Test seam: build the worker runtime without a PTY. Production omits it. */
  createRuntime?: (input: RuntimeCompose) => WorkerRuntime
  planStore?: Pick<PlanStore, 'get'>
  worktrees?: WorktreeService
  sessions?: WorkerSessionPort
  verify?: (input: VerifyInput) => Promise<VerifyOutcome>
  settings?: () => { agentLaunchCommands: Partial<Record<string, string>> }
  dataDir?: () => string
  gitExec?: Exec
}

export function orchestratorRunEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[ORCHESTRATOR_RUN_FLAG] === 'on'
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

interface RawRun {
  projectId: string
  itemId: string
  expectedVersion: number
  prompt?: string
  baseRef?: string
  timeoutMs?: number
}

function invalid(error: string, message?: string): { ok: false; result: RouteResult } {
  return { ok: false, result: { status: 400, body: message ? { error, message } : { error } } }
}
/** Validates the payload. Server-resolved fields are refused, not silently ignored. */
export function parseRunBody(
  body: unknown
): { ok: true; value: RawRun } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_CONTROLLED_FIELDS) {
    if (field in raw) {
      return invalid('client_controlled_field', `${field} is resolved server-side and must not be sent`)
    }
  }
  const projectId = text(raw['projectId'], MAX_ID_CHARS)
  if (projectId === null) return invalid('invalid_project_id')
  const itemId = text(raw['itemId'], MAX_ID_CHARS)
  if (itemId === null) return invalid('invalid_item_id')
  const rawVersion = raw['expectedVersion']
  const expectedVersion =
    typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : null
  if (expectedVersion === null) return invalid('invalid_expected_version')
  let prompt: string | undefined
  if (raw['prompt'] !== undefined) {
    if (typeof raw['prompt'] !== 'string' || raw['prompt'].length > MAX_PROMPT_CHARS) {
      return invalid('invalid_prompt')
    }
    prompt = raw['prompt']
  }
  let baseRef: string | undefined
  if (raw['baseRef'] !== undefined) {
    const ref = text(raw['baseRef'], MAX_BASE_REF_CHARS)
    if (ref === null) return invalid('invalid_base_ref')
    if (ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
      return invalid('invalid_base_ref', 'baseRef has characters git rejects')
    }
    baseRef = ref
  }
  let timeoutMs: number | undefined
  if (raw['timeoutMs'] !== undefined) {
    const value = raw['timeoutMs']
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('invalid_timeout')
    timeoutMs = Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
  }
  return {
    ok: true,
    value: {
      projectId,
      itemId,
      expectedVersion,
      ...(prompt === undefined ? {} : { prompt }),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

function projectRepo(db: Database, projectId: string): string | null {
  const row = db.query('SELECT path FROM project WHERE id = ?').get(projectId) as
    | { path?: unknown }
    | null
  return typeof row?.path === 'string' && row.path.trim() !== '' ? row.path : null
}

/** 409 `not_assigned`: plan/item/assignment must already exist. This route never creates them. */
function assignmentProblem(
  plan: Pick<PlanStore, 'get'>,
  projectId: string,
  itemId: string
): string | null {
  let stored
  try {
    stored = plan.get(projectId)
  } catch {
    return `plan store unavailable for project ${projectId}`
  }
  if (stored === null) return `project ${projectId} has no plan`
  const item = stored.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) return `no item ${itemId} in plan ${stored.id}`
  if (item.status !== 'assigned' || item.taskId === null || item.assignee === null) {
    return `item ${itemId} is ${item.status}; assign a task to it before running`
  }
  return null
}

async function agentCommand(deps: OrchestratorRunDeps): Promise<string> {
  try {
    const settings = deps.settings ? deps.settings() : (await import('./db')).db.getSettings()
    return settings.agentLaunchCommands[DEFAULT_AGENT_ID]?.trim() || DEFAULT_AGENT_CMD
  } catch {
    // A broken settings read must not block an otherwise valid run: the plain launcher works.
    return DEFAULT_AGENT_CMD
  }
}

function gitExecFor(deps: OrchestratorRunDeps, root: string): Exec {
  const runExec = createProcessExec()
  return (
    deps.gitExec ??
    ((file, args) =>
      runExec(file, args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_OUTPUT_BYTES }))
  )
}

/** Production composition: real sessions, real verifier, one runtime per request. */
async function productionRuntime(
  deps: OrchestratorRunDeps,
  compose: RuntimeCompose
): Promise<WorkerRuntime> {
  const sessions = deps.sessions ?? createSessionsPort((await import('./sessions')).sessions)
  const ctx = contextOf({
    ledger: (deps.ledger?.ledger ?? {}) as never,
    plan: compose.plan as PlanStore,
    worktrees: compose.worktrees,
  })
  return createWorkerRuntime({
    orchestrator: {
      startWorker: (input) => startWorker(ctx, input),
      recordWorkerResult: (input) => recordWorkerResult(ctx, input),
    },
    sessions,
    verify:
      deps.verify ??
      ((input: VerifyInput) => verifyWorktree({ root: compose.root, exec: createProcessExec() }, input)),
    worktrees: compose.worktrees,
    cmd: compose.cmd,
    agentId: DEFAULT_AGENT_ID,
    plan: compose.plan as PlanStore,
  })
}

/** POST /api/orchestrator/run. `{ok,outcome}` at 200, typed errors at 409, 500 only unexpected. */
export async function orchestratorRunRoute(
  body: unknown,
  deps: OrchestratorRunDeps
): Promise<RouteResult> {
  if (!(deps.enabled ?? orchestratorRunEnabled())) {
    return { status: 503, body: { error: 'orchestrator_off' } }
  }
  const ledger = deps.ledger
  if (!ledger) return { status: 503, body: { error: 'ledger_off' } }
  const parsed = parseRunBody(body)
  if (!parsed.ok) return parsed.result
  const request = parsed.value

  let repo: string | null
  try {
    repo = projectRepo(ledger.db, request.projectId)
  } catch {
    return { status: 500, body: { error: 'internal' } }
  }
  if (repo === null) {
    return {
      status: 409,
      body: { error: 'not_assigned', message: `project ${request.projectId} has no repo path` },
    }
  }

  const plan = deps.planStore ?? createPlanStore(ledger.db)
  const problem = assignmentProblem(plan, request.projectId, request.itemId)
  if (problem !== null) return { status: 409, body: { error: 'not_assigned', message: problem } }

  const root = join(deps.dataDir ? deps.dataDir() : dataDir(), 'worktrees')
  const worktrees =
    deps.worktrees ?? createWorktreeService({ root, exec: gitExecFor(deps, root) })

  try {
    const compose: RuntimeCompose = { root, repo, cmd: await agentCommand(deps), plan, worktrees }
    const worker = deps.createRuntime ? deps.createRuntime(compose) : await productionRuntime(deps, compose)
    const input: WorkerRunInput = {
      projectId: request.projectId,
      itemId: request.itemId,
      expectedVersion: request.expectedVersion,
      repo,
      ...(parsed.value.prompt === undefined ? {} : { prompt: parsed.value.prompt }),
      ...(parsed.value.baseRef === undefined ? {} : { baseRef: parsed.value.baseRef }),
      ...(parsed.value.timeoutMs === undefined ? {} : { timeoutMs: parsed.value.timeoutMs }),
    }
    const outcome: WorkerRunOutcome = await worker.runTask(input)
    if (outcome.ok) return { status: 200, body: { ok: true, outcome } }
    return {
      status: 409,
      body: {
        ok: false,
        error: {
          code: outcome.error?.code ?? 'run_failed',
          message: outcome.error?.message ?? 'worker run failed',
        },
        outcome,
      },
    }
  } catch {
    // Never echo the exception: it can quote absolute worktree paths or worker output.
    return { status: 500, body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } } }
  }
}
