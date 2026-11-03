// Server-side composition for POST /api/orchestrator/run: resolve WHAT runs (repo, agent cmd),
// WHERE it runs (worktree root) and the worker runtime. Every value here comes from the database,
// settings or the filesystem, never from the request body.
import { delimiter, join } from 'node:path'
import { accessSync, constants, mkdirSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { type PlanStore } from './orchestrator/plan'
import { createWorktreeService, type Exec, type WorktreeService } from './orchestrator/worktree'
import {
  createSessionsPort,
  createWorkerRuntime,
  type WorkerRunInput,
  type WorkerRuntime,
  type WorkerSessionPort,
} from './orchestrator/workerRuntime'
import { contextOf } from './orchestrator/orchestratorSupport'
import { recordWorkerResult, startWorker } from './orchestrator/orchestratorRun'
import { verifyWorktree, type VerifyInput, type VerifyOutcome } from './orchestrator/verify'
import { createProcessExec } from './orchestrator/verifier'
import { dataDir } from './config'
import { DEFAULT_AGENT_ID, resolveWorkerKind, type RawRun, type RouteResult } from './orchestratorRunModel'
import type { ApprovalPort } from './orchestrator/approvalGate'
import { idleDoneMs, withCandidateSignal, type GitProbe } from './orchestrator/workerSignal'
import { createLogger } from './logs'
import { assembleCmd, isBuiltinAgent } from '../shared/workspace'

export { approvalMissing, approvalPortOf, guardedRun } from './orchestratorRunApproval'

const log = createLogger('orchestrator')
const SIGNAL_GIT_TIMEOUT_MS = 15_000
const SIGNAL_GIT_OUTPUT_BYTES = 64 * 1024

const GIT_TIMEOUT_MS = 120_000
const GIT_OUTPUT_BYTES = 256 * 1024

export interface RuntimeCompose {
  root: string
  repo: string
  cmd: string
  /** Worker kind resolved from settings; absent = legacy `claude`. */
  agentId?: string
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
  /** Approval ledger port; production defaults to `ledger.ledger.approval`. */
  approval?: ApprovalPort
  /** Defaults to the `WEBTERM_RUN_REQUIRE_APPROVAL` flag; tests may pin it. */
  requireApproval?: boolean
  /** Injected clock for approval expiry checks; defaults to `Date.now()`. */
  now?: () => number
  /** Test seam: is `claude` installed? Production probes PATH (only matters when nothing is configured). */
  claudeOnPath?: () => boolean
}

export function projectRepo(db: Database, projectId: string): string | null {
  const row = db.query('SELECT path FROM project WHERE id = ?').get(projectId) as
    | { path?: unknown }
    | null
  return typeof row?.path === 'string' && row.path.trim() !== '' ? row.path : null
}

/**
 * Pause gate for worker runs: `true` only when the project row is exactly `paused`.
 * `null` means no such project row, so a missing project is never reported as paused
 * (the route keeps its existing `not_assigned` answer for that case).
 */
export function projectPaused(db: Database, projectId: string): boolean | null {
  const row = db.query('SELECT status FROM project WHERE id = ?').get(projectId) as
    | { status?: unknown }
    | null
  if (row === null || row === undefined) return null
  return row.status === 'paused'
}

/** 409 `not_assigned`: plan/item/assignment must already exist. The route never creates them. */
export function assignmentProblem(
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

/**
 * Task bound to the plan item this run targets, or `null` when the plan/item cannot be read.
 * The route resolves it BEFORE the approval gate so a task-bound approval cannot authorize a
 * different item's task in the same project. `null` fails closed: it never matches a
 * task-bound approval (only `approval.taskId === null`, a generic approval, ignores it).
 */
export function runItemTaskId(
  plan: Pick<PlanStore, 'get'>,
  projectId: string,
  itemId: string
): string | null {
  let stored
  try {
    stored = plan.get(projectId)
  } catch {
    return null
  }
  return stored?.items.find((candidate) => candidate.id === itemId)?.taskId ?? null
}

/** True when an executable `name` exists in a PATH directory. */
function binaryOnPath(name: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // Not in this directory (or unreadable): keep scanning; absence overall is the answer.
      return false
    }
  })
}

/** Worker kind + launch line from `settings.agentLaunchCommands` (user override wins over the builtin launcher). */
export async function workerLaunch(deps: OrchestratorRunDeps): Promise<{ agentId: string; cmd: string }> {
  let configured: Partial<Record<string, string>> = {}
  try {
    const settings = deps.settings ? deps.settings() : (await import('./db')).db.getSettings()
    configured = settings.agentLaunchCommands
  } catch {
    // A broken settings read must not block an otherwise valid run: fall back to the default launcher.
    log.warn('orchestrator.worker.settings', 'settings unreadable; using default worker launcher', { code: 'settings_unreadable' })
  }
  const claudeOnPath = (deps.claudeOnPath ?? (() => binaryOnPath('claude')))()
  const agentId = resolveWorkerKind(configured, claudeOnPath)
  const cmd = isBuiltinAgent(agentId) ? assembleCmd(agentId, configured[agentId]) : agentId
  return { agentId, cmd }
}

function gitExecFor(deps: OrchestratorRunDeps, root: string): Exec {
  const runExec = createProcessExec()
  return (
    deps.gitExec ??
    ((file, args) =>
      runExec(file, args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_OUTPUT_BYTES }))
  )
}

/** Maps a validated request onto the runtime input; `repo` is always server-resolved. */
export function workerInput(request: RawRun, repo: string): WorkerRunInput {
  return {
    projectId: request.projectId,
    itemId: request.itemId,
    expectedVersion: request.expectedVersion,
    repo,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  }
}

/** Production composition: real sessions, real verifier, one runtime per request. */
export async function productionRuntime(
  deps: OrchestratorRunDeps,
  compose: RuntimeCompose
): Promise<WorkerRuntime> {
  const base = deps.sessions ?? createSessionsPort((await import('./sessions')).sessions)
  const agentId = compose.agentId ?? DEFAULT_AGENT_ID
  // Non-claude kinds report no `done` hook: idle + a changed worktree is their candidate signal.
  const sessions = agentId === DEFAULT_AGENT_ID ? base : withCandidateSignal(base, { thresholdMs: idleDoneMs(), probe: signalProbe(deps) })
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
    agentId,
    plan: compose.plan as PlanStore,
  })
}

function signalProbe(deps: OrchestratorRunDeps): GitProbe {
  const runExec = createProcessExec()
  return async (cwd, args) =>
    deps.gitExec
      ? await deps.gitExec('git', ['-C', cwd, ...args])
      : await runExec('git', args, { cwd, timeoutMs: SIGNAL_GIT_TIMEOUT_MS, maxOutputBytes: SIGNAL_GIT_OUTPUT_BYTES })
}

export function worktreeRoot(deps: OrchestratorRunDeps): string {
  return join(deps.dataDir ? deps.dataDir() : dataDir(), 'worktrees')
}

/** Resolves the worktree service, creating the root dir on a fresh install. */
export function resolveWorktrees(
  deps: OrchestratorRunDeps,
  root: string
): { ok: true; worktrees: WorktreeService } | { ok: false; result: RouteResult } {
  if (deps.worktrees) return { ok: true, worktrees: deps.worktrees }
  // config.ts only creates the data dir, so `<data>/worktrees` is missing on a fresh install.
  // Every git exec runs with `cwd: root`; spawning there without the dir makes the first run
  // fail 409 worktree_failed. Create it (private mode) before the service or git touches it.
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch {
    return {
      ok: false,
      result: {
        status: 500,
        body: { ok: false, error: { code: 'worktree_root_failed', message: 'worktree root is unavailable' } },
      },
    }
  }
  return { ok: true, worktrees: createWorktreeService({ root, exec: gitExecFor(deps, root) }) }
}
