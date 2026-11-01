// Client for the operator inbox and the blocking approval queue.
//
// This is the HUMAN surface: every request carries the transport token (`x-webterm-token`). It
// never uses a node capability (`x-webterm-capability`): an agent must not be able to approve its
// own irreversible action. Transport details (token lookup, fetch wrapper, response mapping) live
// in `./inboxTransport` and are re-exported here so importers have one entry point.
//
// Response contracts (the server mounts these under /api; P3 wiring):
//   GET  /api/inbox                        -> { items: InboxItem[] } | InboxItem[]
//   GET  /api/approvals?status=approved    -> { items: ApprovedApproval[] } | ApprovedApproval[]
//   POST /api/control/approval/request     -> ApprovalChallenge
//   POST /api/control/approval/decide      -> ApprovalDecision
//   POST /api/control/approval/consume     -> ApprovalConsumeResult
import type {
  ApprovalChallenge,
  ApprovalConsumeInput,
  ApprovalConsumeResult,
  ApprovalDecideInput,
  ApprovalDecision,
  ApprovalRequestInput,
  ApprovalStatus,
  ApprovedApproval,
  InboxClient,
  InboxItem,
  RequestOptions,
} from './inboxTypes'
import { InboxApiError } from './inboxTypes'
import {
  APPROVAL_PATH,
  APPROVAL_STATUSES,
  INBOX_PATH,
  newRequestId,
  request,
  requireText,
  toChallenge,
  toItem,
} from './inboxTransport'

export * from './inboxTypes'
export { APPROVAL_PATH, INBOX_PATH, inboxErrorMessage, isAbortError } from './inboxTransport'

/** Rows accepted per approved-list read. The server caps at 100; 50 is the panel's page. */
const APPROVED_LIMIT = 50
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** `{ items }` or a bare array; null when the body is neither. */
function responseRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body
  const items = body && typeof body === 'object' ? (body as { items?: unknown }).items : undefined
  return Array.isArray(items) ? items : null
}

/** One approved-list row, or null when it cannot be consumed as-is. Never throws. */
function toApprovedApproval(raw: unknown): ApprovedApproval | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = optionalText(row.id)
  const digest = optionalText(row.digest)
  const projectId = optionalText(row.projectId)
  const kind = optionalText(row.kind)
  // Expiry decides whether Consume can still be offered; an unreadable one is not resumable.
  if (!id || !digest || !projectId || !kind) return null
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) return null
  const taskId = optionalText(row.taskId)
  const fence =
    typeof row.fence === 'number' && Number.isInteger(row.fence) && row.fence > 0 ? row.fence : undefined
  return {
    id,
    projectId,
    kind,
    digest,
    expiresAt: row.expiresAt,
    ...(taskId === undefined ? {} : { taskId }),
    ...(fence === undefined ? {} : { fence }),
  }
}

/** Approved-but-unconsumed consent (QC B4): resumes a task review whose decide response was lost. */
export async function listApproved(opts: RequestOptions = {}): Promise<ApprovedApproval[]> {
  const body = await request<unknown>(
    `${APPROVAL_PATH}?status=approved&limit=${APPROVED_LIMIT}`,
    { method: 'GET', signal: opts.signal }
  )
  const rows = responseRows(body)
  if (rows === null) throw new InboxApiError('Approved list has no items', 502, 'bad_response')
  return rows.map(toApprovedApproval).filter((row): row is ApprovedApproval => row !== null)
}

/** Items waiting for the operator, newest state first as the server orders them. */
export async function listInbox(opts: RequestOptions = {}): Promise<InboxItem[]> {
  const body = await request<unknown>(INBOX_PATH, { method: 'GET', signal: opts.signal })
  const rows = responseRows(body)
  if (rows === null) throw new InboxApiError('Inbox response has no items', 502, 'bad_response')
  return rows.map(toItem).filter((item): item is InboxItem => item !== null)
}

/** Ask the server to mint a challenge for the exact action. Approving always starts here:
 *  the client never signs a digest it produced itself. */
export async function requestApproval(
  input: ApprovalRequestInput,
  opts: RequestOptions = {}
): Promise<ApprovalChallenge> {
  requireText(input.kind, 'kind')
  requireText(input.projectId, 'projectId')
  const body = await request<unknown>(`${APPROVAL_PATH}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: input.requestId ?? newRequestId(),
      kind: input.kind,
      projectId: input.projectId,
      request: input.request,
    }),
    signal: opts.signal,
  })
  return toChallenge(body, { kind: input.kind, projectId: input.projectId })
}

/** Fetch the existing challenge for an inbox approval item (does not create a new approval). */
export async function getApprovalChallenge(
  id: string,
  opts: RequestOptions = {}
): Promise<ApprovalChallenge> {
  if (typeof id !== 'string' || id === '') throw new InboxApiError('invalid_approval_id', 400, 'invalid_id')
  const body = await request<unknown>(`${APPROVAL_PATH}/challenge?id=${encodeURIComponent(id)}`, {
    ...opts,
  })
  return toChallenge(body, { kind: 'approval', projectId: '' })
}

/** Record a decision. Both digest and nonce must be echoed exactly; a changed or stale
 *  challenge is rejected by the server with a typed error the panel surfaces. */
export async function decideApproval(
  input: ApprovalDecideInput,
  opts: RequestOptions = {}
): Promise<ApprovalDecision> {
  requireText(input.id, 'id')
  requireText(input.digest, 'digest')
  requireText(input.nonce, 'nonce')
  const body = await request<unknown>(`${APPROVAL_PATH}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: input.requestId ?? newRequestId(),
      id: input.id,
      digest: input.digest,
      nonce: input.nonce,
      approve: input.approve === true,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    }),
    signal: opts.signal,
  })
  if (!body || typeof body !== 'object') {
    throw new InboxApiError('Decision response missing', 502, 'bad_response')
  }
  const row = body as Record<string, unknown>
  const status = row.status
  if (typeof row.id !== 'string' || typeof status !== 'string' || !APPROVAL_STATUSES.includes(status as ApprovalStatus)) {
    throw new InboxApiError('Decision response malformed', 502, 'bad_response')
  }
  return {
    id: row.id,
    status: status as ApprovalStatus,
    ...(typeof row.digest === 'string' ? { digest: row.digest } : {}),
    ...(typeof row.expiresAt === 'number' ? { expiresAt: row.expiresAt } : {}),
  }
}

/** Spend an approved challenge. This is the step that actually lets the action run, so the
 *  panel only offers it after a decision came back `approved`. */
export async function consumeApproval(
  input: ApprovalConsumeInput,
  opts: RequestOptions = {}
): Promise<ApprovalConsumeResult> {
  requireText(input.id, 'id')
  requireText(input.digest, 'digest')
  const body = await request<unknown>(`${APPROVAL_PATH}/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: input.requestId ?? newRequestId(), id: input.id, digest: input.digest }),
    signal: opts.signal,
  })
  if (!body || typeof body !== 'object') {
    throw new InboxApiError('Consume response missing', 502, 'bad_response')
  }
  const row = body as Record<string, unknown>
  if (row.ok !== true) throw new InboxApiError('Approval was not consumed', 409, 'not_consumed')
  return { ok: true, ...(typeof row.id === 'string' ? { id: row.id } : {}) }
}

/** Default client, and the shape tests/fakes implement. */
export const inboxApi: InboxClient = {
  listInbox,
  listApproved,
  getApprovalChallenge,
  requestApproval,
  decideApproval,
  consumeApproval,
}
