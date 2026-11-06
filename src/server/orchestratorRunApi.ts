// HTTP surface for ONE production worker run: POST /api/orchestrator/run.
// The request only names a project/item and a plan version. Repo, command, agent and exec are
// resolved SERVER-SIDE (project.path + settings), never taken from the payload: a run spawns a
// real PTY, so a client-supplied repo/cmd would be remote command execution.
// The route does not create tasks/agents/plans. An item must already be `assigned` by the
// orchestrator (assign flow); otherwise this answers 409 `not_assigned` and touches nothing.
// A paused project or a terminal plan (`completed`/`abandoned`) answers 409 before any work.
// This module is the route seam only: payload parsing lives in `orchestratorRunModel` and
// production composition (repo/agent/worktree/runtime) in `orchestratorRunProduction`.
// `WEBTERM_RUN_REQUIRE_APPROVAL=on` makes approval mandatory; otherwise a named one is consumed.
import { createPlanStore, type Plan } from './orchestrator/plan'
import { LEDGER_OFF } from './apiShared.types'
import { createLogger } from './logs'
import type { WorkerRunOutcome } from './orchestrator/workerRuntime'
import {
  ORCHESTRATOR_REQUIRE_APPROVAL_FLAG,
  ORCHESTRATOR_RUN_FLAG,
  ORCHESTRATOR_RUN_PATH,
  orchestratorRunEnabled,
  orchestratorRunRequireApproval,
  parseRunBody,
  type RouteResult,
} from './orchestratorRunModel'
import {
  assignmentProblem,
  guardedRun,
  productionRuntime,
  projectPaused,
  projectRepo,
  resolveWorktrees,
  runItemTaskId,
  workerLaunch,
  workerInput,
  worktreeRoot,
  type OrchestratorRunDeps,
  type RuntimeCompose,
} from './orchestratorRunProduction'

export {
  ORCHESTRATOR_REQUIRE_APPROVAL_FLAG,
  ORCHESTRATOR_RUN_FLAG,
  ORCHESTRATOR_RUN_PATH,
  orchestratorRunEnabled,
  orchestratorRunRequireApproval,
  parseRunBody,
  type RouteResult,
}
export type { OrchestratorRunDeps, RuntimeCompose }

const log = createLogger('orchestrator')
const cause = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** POST /api/orchestrator/run. `{ok,outcome}` at 200, typed errors at 409, 500 only unexpected. */
export async function orchestratorRunRoute(
  body: unknown,
  deps: OrchestratorRunDeps
): Promise<RouteResult> {
  if (!(deps.enabled ?? orchestratorRunEnabled())) {
    return { status: 503, body: { error: 'orchestrator_off' } }
  }
  const ledger = deps.ledger
  if (!ledger) return LEDGER_OFF
  const parsed = parseRunBody(body)
  if (!parsed.ok) return parsed.result
  const request = parsed.value

  // A paused project must not start new work. Checked before repo/plan/worktree so a paused
  // request creates no runtime, worktree root or git exec at all.
  let paused: boolean | null
  try {
    paused = projectPaused(ledger.db, request.projectId)
  } catch (err) {
    log.error('orchestrator.run_pause_check_failed', 'reading the project pause state failed', { projectId: request.projectId, error: cause(err) })
    return { status: 500, body: { error: 'internal' } }
  }
  if (paused === true) {
    return {
      status: 409,
      body: {
        error: 'project_paused',
        message: `project ${request.projectId} is paused; resume it before running`,
      },
    }
  }

  let repo: string | null
  try {
    repo = projectRepo(ledger.db, request.projectId)
  } catch (err) {
    log.error('orchestrator.run_repo_failed', 'reading the project repo failed', { projectId: request.projectId, error: cause(err) })
    return { status: 500, body: { error: 'internal' } }
  }
  if (repo === null) {
    const message = `project ${request.projectId} has no repo path`
    return { status: 409, body: { error: 'not_assigned', message } }
  }

  const plan = deps.planStore ?? createPlanStore(ledger.db)

  // A terminal plan must not start new work. The read is best-effort here: `assignmentProblem`
  // still owns every `not_assigned` answer (missing plan, unreadable store, unassigned item),
  // so a failure above only skips this gate instead of changing those responses.
  let stored: Plan | null = null
  try {
    stored = plan.get(request.projectId)
  } catch (err) {
    log.warn('orchestrator.run_plan_read_failed', 'plan read failed; closed-plan gate skipped', { projectId: request.projectId, error: cause(err) })
    stored = null
  }
  if (stored !== null && (stored.status === 'completed' || stored.status === 'abandoned')) {
    return {
      status: 409,
      body: {
        error: 'plan_closed',
        message: `plan ${stored.id} is ${stored.status}; no new runs`,
      },
    }
  }

  const problem = assignmentProblem(plan, request.projectId, request.itemId)
  if (problem !== null) return { status: 409, body: { error: 'not_assigned', message: problem } }

  // The item's own task, resolved before the gate so a task-bound approval for the same project
  // but another item is refused (409 approval_task_mismatch) instead of running the wrong item.
  const expectedTaskId = runItemTaskId(plan, request.projectId, request.itemId)

  // Everything that could refuse the request has answered by now, so the approval gate below is
  // the first thing that can consume a decision. It also wraps worktree allocation and runtime
  // creation, so a rejected approval leaves no root dir, no git exec and no PTY.
  const startRun = async (): Promise<RouteResult> => {
    const root = worktreeRoot(deps)
    const resolved = resolveWorktrees(deps, root)
    if (!resolved.ok) return resolved.result
    const worktrees = resolved.worktrees

    try {
      const compose: RuntimeCompose = { root, repo, ...(await workerLaunch(deps)), plan, worktrees }
      const worker = deps.createRuntime ? deps.createRuntime(compose) : await productionRuntime(deps, compose)
      const outcome: WorkerRunOutcome = await worker.runTask(workerInput(request, repo))
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
    } catch (err) {
      // Never echo the exception to the client: it can quote absolute worktree paths or worker output.
      // The log keeps the cause (redacted by the log gate) so the 500 is diagnosable.
      log.error('orchestrator.run_failed', 'orchestrator run failed', { projectId: request.projectId, itemId: request.itemId, error: cause(err) })
      return {
        status: 500,
        body: { ok: false, error: { code: 'internal', message: 'orchestrator run failed' } },
      }
    }
  }
  return await guardedRun(deps, request, startRun, expectedTaskId)
}
