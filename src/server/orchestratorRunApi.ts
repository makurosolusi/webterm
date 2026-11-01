// HTTP surface for ONE production worker run: POST /api/orchestrator/run.
// The request only names a project/item and a plan version. Repo, command, agent and exec are
// resolved SERVER-SIDE (project.path + settings), never taken from the payload: a run spawns a
// real PTY, so a client-supplied repo/cmd would be remote command execution.
//
// The route does not create tasks/agents/plans. An item must already be `assigned` by the
// orchestrator (assign flow); otherwise this answers 409 `not_assigned` and touches nothing.
// A paused project or a terminal plan (`completed`/`abandoned`) answers 409 before any work.
//
// This module is the route seam only: payload parsing lives in `orchestratorRunModel` and
// production composition (repo/agent/worktree/runtime) in `orchestratorRunProduction`.
import { createPlanStore, type Plan } from './orchestrator/plan'
import type { WorkerRunInput, WorkerRunOutcome } from './orchestrator/workerRuntime'
import {
  ORCHESTRATOR_RUN_FLAG,
  ORCHESTRATOR_RUN_PATH,
  orchestratorRunEnabled,
  parseRunBody,
  type RouteResult,
} from './orchestratorRunModel'
import {
  agentCommand,
  assignmentProblem,
  productionRuntime,
  projectPaused,
  projectRepo,
  resolveWorktrees,
  worktreeRoot,
  type OrchestratorRunDeps,
  type RuntimeCompose,
} from './orchestratorRunProduction'

export {
  ORCHESTRATOR_RUN_FLAG,
  ORCHESTRATOR_RUN_PATH,
  orchestratorRunEnabled,
  parseRunBody,
  type RouteResult,
}
export type { OrchestratorRunDeps, RuntimeCompose }

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

  // A paused project must not start new work. Checked before repo/plan/worktree so a paused
  // request creates no runtime, worktree root or git exec at all.
  let paused: boolean | null
  try {
    paused = projectPaused(ledger.db, request.projectId)
  } catch {
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
  } catch {
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
  } catch {
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

  const root = worktreeRoot(deps)
  const resolved = resolveWorktrees(deps, root)
  if (!resolved.ok) return resolved.result
  const worktrees = resolved.worktrees

  try {
    const compose: RuntimeCompose = { root, repo, cmd: await agentCommand(deps), plan, worktrees }
    const worker = deps.createRuntime ? deps.createRuntime(compose) : await productionRuntime(deps, compose)
    const input: WorkerRunInput = {
      projectId: request.projectId,
      itemId: request.itemId,
      expectedVersion: request.expectedVersion,
      repo,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
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
