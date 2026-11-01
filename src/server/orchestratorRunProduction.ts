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
  type WorkerRunInput,
  type WorkerRuntime,
  type WorkerSessionPort,
} from './orchestrator/workerRuntime'
import { contextOf } from './orchestrator/orchestratorSupport'
import { recordWorkerResult, startWorker } from './orchestrator/orchestratorRun'
import { verifyWorktree, type VerifyInput, type VerifyOutcome } from './orchestrator/verify'
import { createProcessExec } from './orchestrator/verifier'
import { dataDir } from './config'
import { DEFAULT_AGENT_CMD, DEFAULT_AGENT_ID, orchestratorRunRequireApproval, type RawRun, type RouteResult } from './orchestratorRunModel'
import {
  ApprovalRequiredError,
  runApproved,
  type ApprovalPort,
  type ApprovalRequest,
} from './orchestrator/approvalGate'

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
  /** Approval ledger port; production defaults to `ledger.ledger.approval`. */
  approval?: ApprovalPort
  /** Defaults to the `WEBTERM_RUN_REQUIRE_APPROVAL` flag; tests may pin it. */
  requireApproval?: boolean
  /** Injected clock for approval expiry checks; defaults to `Date.now()`. */
  now?: () => number
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

const APPROVAL_REQUIRED: RouteResult = {
  status: 409,
  body: {
    error: 'approval_required',
    message: 'run requires approvalId and approvalDigest from an approved ledger decision',
  },
}

const INTERNAL_RUN_FAILURE: RouteResult = {
  status: 500,
  body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } },
}

/**
 * 409 `approval_project_mismatch`: the named approval was issued for another project. Nothing is
 * consumed and nothing runs; the message never echoes the approval id or digest.
 */
const APPROVAL_PROJECT_MISMATCH: RouteResult = {
  status: 409,
  body: {
    error: 'approval_rejected',
    code: 'approval_project_mismatch',
    message: 'approval does not belong to the requested project',
  },
}

/** Production uses the ledger facade's approval slice; tests may inject a narrow port. */
export function approvalPortOf(deps: OrchestratorRunDeps): ApprovalPort | null {
  if (deps.approval) return deps.approval
  const port = (deps.ledger?.ledger as { approval?: Partial<ApprovalPort> } | undefined)?.approval
  if (typeof port?.getApproval !== 'function' || typeof port.consumeApproval !== 'function') {
    return null
  }
  return port as ApprovalPort
}

/** Policy gate: on only when the flag is set AND the request names no approval. */
export function approvalMissing(deps: OrchestratorRunDeps, request: RawRun): boolean {
  if (!(deps.requireApproval ?? orchestratorRunRequireApproval())) return false
  return request.approvalId === undefined || request.approvalDigest === undefined
}

/**
 * Runs `action` behind the ledger approval named by the request, so consent is consumed exactly
 * once BEFORE any spawn or worktree allocation. A rejection returns 409 and never reaches
 * `action`; the message may name the approval id but never echoes the digest.
 *
 * Field presence is decided here, after body/project/plan validation, so an invalid request
 * never burns an approval and a missing one is reported as policy (409), not malformed (400).
 */
export async function guardedRun(
  deps: OrchestratorRunDeps,
  request: RawRun,
  action: () => Promise<RouteResult>
): Promise<RouteResult> {
  const { approvalId, approvalDigest } = request
  if (approvalId === undefined || approvalDigest === undefined) {
    return approvalMissing(deps, request) ? APPROVAL_REQUIRED : await action()
  }
  const port = approvalPortOf(deps)
  if (port === null) {
    return {
      status: 409,
      body: {
        error: 'approval_rejected',
        code: 'approval_unavailable',
        message: 'approval ledger is unavailable',
      },
    }
  }
  const now = deps.now?.()
  const gateRequest: ApprovalRequest =
    now === undefined
      ? { approvalId, digest: approvalDigest }
      : { approvalId, digest: approvalDigest, now }
  try {
    // Project isolation: an approval only authorizes work in the project it was requested for.
    // Reading it here (before the gate consumes) keeps the check off the consume path, and the
    // same snapshot is handed to `runApproved` so a status/digest flip between the two reads
    // cannot slip through. A missing record stays `approval_not_found` inside the gate.
    const approval = port.getApproval(approvalId)
    if (approval !== null && approval.projectId !== request.projectId) {
      return APPROVAL_PROJECT_MISMATCH
    }
    const gatePort: ApprovalPort =
      approval === null
        ? port
        : {
            getApproval: () => approval,
            consumeApproval: (id, input) => port.consumeApproval(id, input),
          }
    return await runApproved({ approval: gatePort }, gateRequest, action)
  } catch (error) {
    // A failed action still burns its approval (the gate has no catch), as designed.
    if (error instanceof ApprovalRequiredError) {
      return {
        status: 409,
        body: { error: 'approval_rejected', code: error.code, message: error.message },
      }
    }
    return INTERNAL_RUN_FAILURE
  }
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
