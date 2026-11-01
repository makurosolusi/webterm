// Handlers for the human approval surface. Pure in the sense that they take a ledger runtime and a
// parsed body and return `{ status, body }`; the HTTP seam lives in `approvalHumanApi.ts`.
// The actor is fixed to 'human': `body.actor` is ignored, so a caller cannot write an audit row
// under someone else's name (QC M1).
import { boundedText, classifyLedgerError, failure, invalid, type RouteFailure } from './approvalFailures'
import { MAX_LIST_LIMIT, listApprovedUnconsumed, projectExists, readChallenge } from './approvalQuery'
import { AckStore, isValidRequestId } from './control/controlTypes'
import { approvalDigest, type Approval } from './ledger/ledgerApproval'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

/** The only actor the human route records; the body cannot override it. */
export const HUMAN_ACTOR = 'human'
const MAX_PROJECT_ID = 200
const MAX_KIND = 128
const MAX_SECRET = 256

export type Result = { status: number; body?: unknown }

/**
 * One ack store per ledger runtime, so a retried requestId replays the original response instead
 * of minting a second consent challenge. Keyed by the runtime object (not by a per-request literal,
 * which is how the control plane's replay window was silently disabled in production).
 */
const ackStores = new WeakMap<object, AckStore>()
function storeFor(runtime: LedgerRuntime): AckStore {
  let store = ackStores.get(runtime)
  if (!store) ackStores.set(runtime, (store = new AckStore()))
  return store
}

const secret = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET ? value : undefined

/** Parses `limit`/`offset`; `null` = invalid, `undefined` = absent. */
function paging(raw: string | null, min: number, max: number): number | undefined | null {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

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

export function challengeRoute(runtime: LedgerRuntime, url: URL, now: number): Result {
  const id = boundedText(url.searchParams.get('id') ?? undefined, MAX_PROJECT_ID)
  if (!id) return invalid('id')
  const view = readChallenge(runtime.db, id, now)
  return view ? { status: 200, body: view } : failure(404, 'approval_not_found')
}

/** `GET /api/approvals?status=approved` — approved-but-unconsumed consent, paginated. */
export function listRoute(runtime: LedgerRuntime, url: URL, now: number): Result {
  if (url.searchParams.get('status') !== 'approved') return invalid('status')
  const projectId = url.searchParams.get('projectId')
  if (projectId !== null && (projectId.trim() === '' || projectId.length > MAX_PROJECT_ID)) {
    return invalid('projectId')
  }
  const limit = paging(url.searchParams.get('limit'), 1, MAX_LIST_LIMIT)
  if (limit === null) return invalid('limit')
  const offset = paging(url.searchParams.get('offset'), 0, 1_000_000)
  if (offset === null) return invalid('offset')
  return {
    status: 200,
    body: listApprovedUnconsumed(runtime.db, {
      ...(projectId === null ? {} : { projectId }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      now,
    }),
  }
}

export function requestRoute(runtime: LedgerRuntime, body: Record<string, unknown>, now: number): Result {
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
