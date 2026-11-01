// Human approval decision and consumption handlers, including the task side effects a review
// decision carries (reject reopens/fails the task, consume verifies it at the seen fence).
import { boundedText, classifyLedgerError, failure, invalid, type RouteFailure } from './approvalFailures'
import { readChallenge } from './approvalQuery'
import { isValidRequestId } from './control/controlTypes'
import { HUMAN_ACTOR, MAX_PROJECT_ID, secret, storeFor, type Result } from './approvalHumanShared'
import { approvalDigest, type Approval } from './ledger/ledgerApproval'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

interface ReviewLink {
  taskId: string
  fence: number
}

/**
 * Task link for a review approval: `approval.task_id` when the request carried one, plus the fence
 * the human saw. Falling back to the request payload keeps older rows decidable.
 */
function reviewLink(approval: Approval): ReviewLink | null {
  if (approval.kind !== 'task') return null
  const payload = (approval.request ?? {}) as { taskId?: unknown; fence?: unknown }
  const taskId = approval.taskId ?? (typeof payload.taskId === 'string' ? payload.taskId : null)
  if (!taskId || typeof payload.fence !== 'number' || !Number.isFinite(payload.fence)) return null
  return { taskId, fence: payload.fence }
}

/** Rejects a review whose task is already terminal or moved past the fence the human saw. */
function checkReviewable(runtime: LedgerRuntime, link: ReviewLink): RouteFailure | null {
  const task = runtime.ledger.task.getTask(link.taskId)
  if (!task) return failure(404, 'task_not_found')
  if (task.fence !== link.fence) return failure(409, 'stale_fence')
  if (task.status === 'verified' || task.status === 'failed' || task.status === 'cancelled') {
    return failure(409, 'task_not_pending')
  }
  return null
}

export function decideRoute(runtime: LedgerRuntime, body: Record<string, unknown>, now: number): Result {
  const id = boundedText(body.id, MAX_PROJECT_ID)
  if (!id) return invalid('id')
  const digest = secret(body.digest)
  if (!digest) return invalid('digest')
  const nonce = secret(body.nonce)
  if (!nonce) return invalid('nonce')
  if (typeof body.approve !== 'boolean') return invalid('approve')
  const requestId = body.requestId
  if (requestId !== undefined && !isValidRequestId(requestId)) return invalid('requestId')
  const store = storeFor(runtime)
  const key = requestId === undefined ? undefined : `approval.decide|approval:${id}|${String(requestId)}`
  if (key !== undefined) {
    const replay = store.get(key, now)
    if (replay) return replay
  }
  const approval = runtime.ledger.approval.getApproval(id)
  if (!approval) return failure(404, 'approval_not_found')
  if (approval.expiresAt !== null && approval.expiresAt <= now) return failure(409, 'approval_expired')
  if (approval.status !== 'pending') return failure(409, 'approval_not_pending')
  if (approvalDigest(approval.request) !== digest) return failure(403, 'digest_mismatch')
  const link = reviewLink(approval)
  if (link) {
    const blocked = checkReviewable(runtime, link)
    if (blocked) return blocked
  }
  let decision
  try {
    decision = runtime.ledger.approval.decideApproval(id, {
      actor: HUMAN_ACTOR,
      approve: body.approve,
      digest,
      nonce,
      now,
    })
    if (!body.approve && link) {
      // Rejection is a task verdict, not an approval side effect: claimed work fails outright,
      // queueable work returns with a fresh fence.
      const task = runtime.ledger.task.getTask(link.taskId)
      if (task?.status === 'claimed_done') {
        runtime.ledger.task.failTask(link.taskId, link.fence, 'rejected by human review', {
          actor: HUMAN_ACTOR,
          payload: { approvalId: id },
        })
      } else if (task?.status !== 'failed') {
        runtime.ledger.task.reopenTask(link.taskId, { actor: HUMAN_ACTOR, payload: { approvalId: id } })
      }
    }
  } catch (err) {
    return classifyLedgerError(err)
  }
  const result: Result = { status: 200, body: { id: decision.id, status: decision.status } }
  if (key !== undefined) store.set(key, result, now)
  return result
}

export function consumeRoute(runtime: LedgerRuntime, body: Record<string, unknown>, now: number): Result {
  const id = boundedText(body.id, MAX_PROJECT_ID)
  if (!id) return invalid('id')
  const digest = secret(body.digest)
  if (!digest) return invalid('digest')
  const requestId = body.requestId
  if (requestId !== undefined && !isValidRequestId(requestId)) return invalid('requestId')
  const store = storeFor(runtime)
  const key = requestId === undefined ? undefined : `approval.consume|approval:${id}|${String(requestId)}`
  if (key !== undefined) {
    const replay = store.get(key, now)
    if (replay) return replay
  }
  const approval = runtime.ledger.approval.getApproval(id)
  if (!approval) return failure(404, 'approval_not_found')
  if (approval.expiresAt !== null && approval.expiresAt <= now) return failure(409, 'approval_expired')
  if (approval.status !== 'approved') return failure(409, 'approval_not_pending')
  if (approvalDigest(approval.request) !== digest) return failure(403, 'digest_mismatch')
  // `single_use` lives on the decision row, not in the Approval port: a spent consent is a
  // one-shot failure even when the linked task has also moved on.
  if (readChallenge(runtime.db, id, now)?.consumed) return failure(409, 'not_consumable')
  const link = reviewLink(approval)
  if (link) {
    const task = runtime.ledger.task.getTask(link.taskId)
    if (!task) return failure(404, 'task_not_found')
    if (task.fence !== link.fence) return failure(409, 'stale_fence')
    if (task.status !== 'claimed_done') return failure(409, 'task_not_pending')
  }
  let result: Result
  try {
    if (!runtime.ledger.approval.consumeApproval(id, { digest, now })) {
      return failure(409, 'not_consumable')
    }
    if (link) {
      // `null` evidence keeps the worker's claim evidence; the approval is named in the event.
      runtime.ledger.task.verifyTask(link.taskId, link.fence, null, {
        actor: HUMAN_ACTOR,
        payload: { approvalId: id },
      })
    }
    result = {
      status: 200,
      body: { ok: true, id, ...(link === null ? {} : { taskId: link.taskId, taskStatus: 'verified' }) },
    }
  } catch (err) {
    return classifyLedgerError(err)
  }
  if (key !== undefined) store.set(key, result, now)
  return result
}
