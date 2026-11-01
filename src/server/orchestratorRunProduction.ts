// Server-side composition for POST /api/orchestrator/run: resolve WHAT runs (repo, agent cmd),
// WHERE it runs (worktree root) and the worker runtime. Every value here comes from the database,
// settings or the filesystem, never from the request body.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { type PlanStore } from './orchestrator/plan'
import { createWorktreeService, type Exec, type WorktreeService } from './orchestrator/worktree'
import {
  createSessionsPort,
  createWorkerRuntime,
  type WorkerRuntime,
  type WorkerSessionPort,
} from './orchestrator/workerRuntime'
import { contextOf } from './orchestrator/orchestratorSupport'
import { recordWorkerResult, startWorker } from './orchestrator/orchestratorRun'
import { verifyWorktree, type VerifyInput, type VerifyOutcome } from './orchestrator/verify'
import { createProcessExec } from './orchestrator/verifier'
import { dataDir } from './config'
import { DEFAULT_AGENT_CMD, DEFAULT_AGENT_ID, type RouteResult } from './orchestratorRunModel'

const GIT_TIMEOUT_MS = 120_000
const GIT_OUTPUT_BYTES = 256 * 1024

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

export async function agentCommand(deps: OrchestratorRunDeps): Promise<string> {
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
export async function productionRuntime(
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
