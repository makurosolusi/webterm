// Approval control plane (P3). Consent is a capability + digest + nonce, never chat text and never
// the root `x-webterm-token`: that header is a human credential and is deliberately unread here.
// The handler is pure: no `Bun`, no fs, no HTTP objects. Production passes `deps.ledger.approval`.
import {
  approvalDigest,
  type Approval,
  type ApprovalChallenge,
  type ApprovalStatus,
  type DecideApprovalInput,
  type RequestApprovalInput,
} from '../ledger/ledgerApproval'
import { badRequest, forbidden } from './controlAuth'
import {
  MAX_ACTOR,
  MAX_KIND,
  MAX_PROJECT_ID,
  MAX_TASK_ID,
  decisionFailure,
  secretField,
  textField,
} from './approvalFields'
import type { CapabilityRecord, CapabilityVerb } from './capabilities'
import {
  AckStore,
  CONTROL_PREFIX,
  asObject,
  headerValue,
  isValidRequestId,
  type ControlCapabilities,
  type ControlRequest,
  type ControlResult,
} from './controlTypes'

export const APPROVAL_PREFIX = `${CONTROL_PREFIX}/approval`
export const APPROVAL_ROUTES = {
  request: `${APPROVAL_PREFIX}/request`,
  decide: `${APPROVAL_PREFIX}/decide`,
  consume: `${APPROVAL_PREFIX}/consume`,
  list: `${APPROVAL_PREFIX}/list`,
} as const

/** Slice of the ledger this API needs. Real implementation: `ledger.approval`. */
export interface ApprovalLedgerPort {
  requestApproval(input: RequestApprovalInput): ApprovalChallenge
  getApproval(id: string): Approval | null
  decideApproval(id: string, input: DecideApprovalInput): Approval
  consumeApproval(id: string, input: { digest: string; now?: number }): boolean
  listApprovals(opts?: { projectId?: string; status?: ApprovalStatus; limit?: number }): Approval[]
}

/** Idempotency window; `AckStore` from controlTypes satisfies this. */
export interface ApprovalAcks {
  get(key: string, now: number): { status: number; body?: unknown } | undefined
  set(key: string, result: { status: number; body?: unknown }, now: number): void
}

export interface ApprovalDeps {
  capabilities: ControlCapabilities
  approval: ApprovalLedgerPort
  /** Optional injected ack store; otherwise one store per deps object (module WeakMap). */
  acks?: ApprovalAcks
  now?: () => number
}

const MAX_LIST_LIMIT = 500
const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired']
const unauthorized: NonNullable<ControlResult> = { status: 401, body: { error: 'unauthorized' } }

/** One ack store per deps identity, so two servers/tests never share a replay window. */
const stores = new WeakMap<ApprovalDeps, AckStore>()
const storeFor = (deps: ApprovalDeps): ApprovalAcks => {
  if (deps.acks) return deps.acks
  let store = stores.get(deps)
  if (!store) stores.set(deps, (store = new AckStore()))
  return store
}

type Authed = { record: CapabilityRecord } | { failure: NonNullable<ControlResult> }

/** Capability-only auth. Never consults `x-webterm-token`, even if it is present. */
function authenticate(req: ControlRequest, deps: ApprovalDeps, now: number): Authed {
  const token = headerValue(req.headers, 'x-webterm-capability')
  const record = token ? deps.capabilities.verify(token, now) : undefined
  return record ? { record } : { failure: unauthorized }
}

function authorize(
  req: ControlRequest,
  deps: ApprovalDeps,
  now: number,
  verb: CapabilityVerb,
  resource: string
): Authed {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth
  if (!deps.capabilities.allows(auth.record, verb, resource)) return { failure: forbidden.failure }
  return auth
}

/** `pathname?query` -> parts. Mount normally strips the query, so the list route also accepts it. */
function splitPath(path: string): { pathname: string; query: URLSearchParams } {
  const at = path.indexOf('?')
  if (at < 0) return { pathname: path, query: new URLSearchParams() }
  return { pathname: path.slice(0, at), query: new URLSearchParams(path.slice(at + 1)) }
}
const projectResource = (projectId: string): string => `project:${projectId}`

function requestRoute(req: ControlRequest, deps: ApprovalDeps, acks: ApprovalAcks, now: number): ControlResult {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const projectId = textField(body.projectId, MAX_PROJECT_ID)
  if (!projectId) return badRequest('invalid_project_id')
  const auth = authorize(req, deps, now, 'approval.request', projectResource(projectId))
  if ('failure' in auth) return auth.failure
  const key = `approval.request|${projectResource(projectId)}|${body.requestId}`
  const replay = acks.get(key, now)
  if (replay) return replay
  const kind = textField(body.kind, MAX_KIND)
  if (!kind) return badRequest('invalid_kind')
  if (body.request === undefined) return badRequest('invalid_request')
  let ttlMs: number | undefined
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      return badRequest('invalid_ttl')
    }
    ttlMs = body.ttlMs
  }
  // Without this the approval can never be linked to a task, so review can never resolve (QC B2).
  let taskId: string | undefined
  if (body.taskId !== undefined) {
    taskId = textField(body.taskId, MAX_TASK_ID)
    if (!taskId) return badRequest('invalid_task_id')
  }
  let challenge: ApprovalChallenge
  try {
    challenge = deps.approval.requestApproval({
      projectId,
      kind,
      request: body.request,
      ...(taskId === undefined ? {} : { taskId }),
      ttlMs,
    })
  } catch {
    // Ledger rejects non-JSON request payloads; nothing sensitive is echoed back.
    return badRequest('invalid_request')
  }
  const result = {
    status: 201,
    body: {
      id: challenge.id,
      digest: challenge.digest,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  }
  acks.set(key, result, now)
  return result
}

/** Resolve the approval and check the decide/consume capability against its project scope. */
function scopedApproval(
  req: ControlRequest,
  deps: ApprovalDeps,
  now: number,
  id: string,
  verb: CapabilityVerb
): { approval: Approval } | { failure: NonNullable<ControlResult> } {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth
  const approval = deps.approval.getApproval(id)
  if (!approval) return { failure: { status: 404, body: { error: 'approval_not_found' } } }
  if (!approval.projectId) return { failure: forbidden.failure }
  if (!deps.capabilities.allows(auth.record, verb, projectResource(approval.projectId))) {
    return { failure: forbidden.failure }
  }
  return { approval }
}

function decideRoute(req: ControlRequest, deps: ApprovalDeps, acks: ApprovalAcks, now: number): ControlResult {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const id = textField(body.id, MAX_PROJECT_ID)
  if (!id) return badRequest('invalid_id')
  const auth = scopedApproval(req, deps, now, id, 'approval.decide')
  if ('failure' in auth) return auth.failure
  if (typeof body.approve !== 'boolean') return badRequest('invalid_approve')
  const digest = secretField(body.digest)
  if (!digest) return badRequest('invalid_digest')
  const nonce = secretField(body.nonce)
  if (!nonce) return badRequest('invalid_nonce')
  const actor = textField(body.actor, MAX_ACTOR)
  if (!actor) return badRequest('invalid_actor')
  const key = `approval.decide|approval:${id}|${body.requestId}`
  const replay = acks.get(key, now)
  if (replay) return replay

  const approval = auth.approval
  if (approval.expiresAt !== null && approval.expiresAt <= now) {
    return { status: 409, body: { error: 'approval_expired' } }
  }
  if (approval.status !== 'pending') {
    return { status: 409, body: { error: 'approval_not_pending', status: approval.status } }
  }
  if (approvalDigest(approval.request) !== digest) {
    return { status: 403, body: { error: 'digest_mismatch' } }
  }
  let decided: Approval
  try {
    decided = deps.approval.decideApproval(id, { actor, approve: body.approve, digest, nonce, now })
  } catch (err) {
    return decisionFailure(err)
  }
  const result = {
    status: 200,
    body: {
      ok: true,
      requestId: body.requestId,
      id: decided.id,
      status: decided.status,
      approvedBy: decided.approvedBy,
      decidedAt: decided.updatedAt,
      actor,
    },
  }
  acks.set(key, result, now)
  return result
}

function consumeRoute(req: ControlRequest, deps: ApprovalDeps, acks: ApprovalAcks, now: number): ControlResult {
  const body = asObject(req.body)
  if (!isValidRequestId(body.requestId)) return badRequest('invalid_request_id')
  const id = textField(body.id, MAX_PROJECT_ID)
  if (!id) return badRequest('invalid_id')
  const auth = scopedApproval(req, deps, now, id, 'approval.consume')
  if ('failure' in auth) return auth.failure
  const digest = secretField(body.digest)
  if (!digest) return badRequest('invalid_digest')
  const key = `approval.consume|approval:${id}|${body.requestId}`
  const replay = acks.get(key, now)
  if (replay) return replay
  // One-shot: false covers not-approved, expired, wrong digest, and already-consumed alike.
  // Only successes are acked: a retry after approval must run, not replay an old 409.
  const consumed = deps.approval.consumeApproval(id, { digest, now })
  if (!consumed) {
    return { status: 409, body: { error: 'not_consumable', requestId: body.requestId, id } }
  }
  const result: NonNullable<ControlResult> = {
    status: 200,
    body: { ok: true, requestId: body.requestId, id, consumed: true },
  }
  acks.set(key, result, now)
  return result
}

function listRoute(req: ControlRequest, deps: ApprovalDeps, query: URLSearchParams, now: number): ControlResult {
  const projectId = textField(query.get('projectId') ?? undefined, MAX_PROJECT_ID)
  if (!projectId) return badRequest('missing_project_id')
  const auth = authorize(req, deps, now, 'approval.read', projectResource(projectId))
  if ('failure' in auth) return auth.failure
  const statusRaw = query.get('status')
  if (statusRaw !== null && !STATUSES.includes(statusRaw as ApprovalStatus)) {
    return badRequest('invalid_status')
  }
  const limitRaw = query.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      return badRequest('invalid_limit')
    }
    limit = parsed
  }
  const rows = deps.approval.listApprovals({
    projectId,
    ...(statusRaw === null ? {} : { status: statusRaw as ApprovalStatus }),
    ...(limit === undefined ? {} : { limit }),
  })
  return { status: 200, body: rows }
}

/**
 * Router keluarga `/api/control/approval/*`. `null` for anything outside the family so the caller
 * falls through to 404. `now` is injectable so replay/expiry can be tested without a wall clock.
 */
export async function handleApproval(
  req: ControlRequest,
  deps: ApprovalDeps,
  now: number = (deps.now ?? Date.now)()
): Promise<ControlResult> {
  const method = req.method.toUpperCase()
  const { pathname, query } = splitPath(req.path)
  if (pathname !== APPROVAL_PREFIX && !pathname.startsWith(`${APPROVAL_PREFIX}/`)) return null
  const acks = storeFor(deps)
  if (method === 'POST' && pathname === APPROVAL_ROUTES.request) return requestRoute(req, deps, acks, now)
  if (method === 'POST' && pathname === APPROVAL_ROUTES.decide) return decideRoute(req, deps, acks, now)
  if (method === 'POST' && pathname === APPROVAL_ROUTES.consume) return consumeRoute(req, deps, acks, now)
  if (method === 'GET' && pathname === APPROVAL_ROUTES.list) return listRoute(req, deps, query, now)
  return null
}
