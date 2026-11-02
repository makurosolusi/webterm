// Human approval request handler: validation, replay window, and the ledger call that mints the
// digest/nonce/expiry triple a human later decides on.
import { boundedText, classifyLedgerError, failure, invalid } from './approvalFailures'
import { projectExists } from './approvalQuery'
import { isValidRequestId } from './control/controlTypes'
import { HUMAN_ACTOR, MAX_KIND, MAX_PROJECT_ID, storeFor, type Result } from './approvalHumanShared'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { createLogger } from './logs'

const log = createLogger('approval')

/**
 * Minting has no actor column in the ledger (`approval.requestedBy` does not exist), so the
 * derived actor is accepted only to keep one dispatch signature across the POST handlers. The
 * identities that matter are recorded when the decision/consumption writes its audit rows.
 */
export function requestRoute(
  runtime: LedgerRuntime,
  body: Record<string, unknown>,
  now: number,
  _actor: string = HUMAN_ACTOR
): Result {
  const projectId = boundedText(body.projectId, MAX_PROJECT_ID)
  if (!projectId) return invalid('projectId')
  const kind = boundedText(body.kind, MAX_KIND)
  if (!kind) return invalid('kind')
  if (body.request === undefined) return invalid('request')
  let ttlMs: number | undefined
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      return invalid('ttl')
    }
    ttlMs = body.ttlMs
  }
  let taskId: string | undefined
  let fence: number | undefined
  if (body.taskId !== undefined) {
    taskId = boundedText(body.taskId, MAX_PROJECT_ID)
    if (!taskId) return invalid('taskId')
    if (typeof body.fence !== 'number' || !Number.isFinite(body.fence)) return invalid('fence')
    fence = body.fence
  } else if (body.fence !== undefined) {
    return invalid('taskId')
  }
  // The fence must be part of the digest: the human approves "task X at fence N", and the ledger
  // has no fence column, so it rides in the request payload `reviewLink` reads later.
  let payload = body.request
  if (taskId !== undefined && fence !== undefined) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return invalid('request')
    }
    payload = { ...(payload as Record<string, unknown>), taskId, fence }
  }
  let requestId: string | undefined
  if (body.requestId !== undefined) {
    if (!isValidRequestId(body.requestId)) return invalid('requestId')
    requestId = body.requestId
  }
  if (!projectExists(runtime.db, projectId)) return failure(404, 'project_not_found')
  const store = storeFor(runtime)
  const key = requestId === undefined ? undefined : `approval.request|project:${projectId}|${requestId}`
  if (key !== undefined) {
    const replay = store.get(key, now)
    if (replay) return replay
  }
  let challenge
  try {
    challenge = runtime.ledger.approval.requestApproval({
      projectId,
      kind,
      request: payload,
      ...(taskId === undefined ? {} : { taskId }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    })
  } catch (err) {
    return classifyLedgerError(err)
  }
  log.info('approval.request', 'Approval requested', { approvalId: challenge.id, kind, linkedTask: taskId !== undefined })
  // `fence` is not a ledger column; it rides in the request payload the digest covers.
  const result: Result = {
    status: 201,
    body: {
      id: challenge.id,
      digest: challenge.digest,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      ...(fence === undefined ? {} : { taskId, fence }),
    },
  }
  if (key !== undefined) store.set(key, result, now)
  return result
}
