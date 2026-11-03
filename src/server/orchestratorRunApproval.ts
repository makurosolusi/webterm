// Approval policy for POST /api/orchestrator/run: which approval (if any) authorizes a run and the
// single-consumption gate around the action. Split from `orchestratorRunProduction` (Rule 8).
import { orchestratorRunRequireApproval, type RawRun, type RouteResult } from './orchestratorRunModel'
import { ApprovalRequiredError, runApproved, type ApprovalPort, type ApprovalRequest } from './orchestrator/approvalGate'
import type { OrchestratorRunDeps } from './orchestratorRunProduction'

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

/**
 * 409 `approval_task_mismatch`: the named approval was issued for another task in the same
 * project. Nothing is consumed and nothing runs; the message never echoes ids or the digest.
 */
const APPROVAL_TASK_MISMATCH: RouteResult = {
  status: 409,
  body: {
    error: 'approval_rejected',
    code: 'approval_task_mismatch',
    message: 'approval does not belong to the task bound to this plan item',
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
 * `expectedTaskId` is the plan item's own task (resolved by the caller). A task-bound approval
 * (`taskId !== null`) only authorizes that task; a generic one (`taskId === null`) is not
 * task-scoped. A `null` expected id fails closed against every task-bound approval.
 *
 * Field presence is decided here, after body/project/plan validation, so an invalid request
 * never burns an approval and a missing one is reported as policy (409), not malformed (400).
 */
export async function guardedRun(
  deps: OrchestratorRunDeps,
  request: RawRun,
  action: () => Promise<RouteResult>,
  expectedTaskId: string | null
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
    if (approval !== null) {
      // Project isolation first: an approval never authorizes work in another project.
      if (approval.projectId !== request.projectId) return APPROVAL_PROJECT_MISMATCH
      // Task isolation: a task-bound approval only authorizes the run item's own task. A generic
      // approval (`taskId === null`) is not task-scoped, so only the project check applies.
      if (approval.taskId !== null && approval.taskId !== expectedTaskId) {
        return APPROVAL_TASK_MISMATCH
      }
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
