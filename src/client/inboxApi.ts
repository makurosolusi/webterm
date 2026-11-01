// Client for the operator inbox and the blocking approval queue.
//
// This is the HUMAN surface: every request carries the transport token (`x-webterm-token`). It
// never uses a node capability (`x-webterm-capability`): an agent must not be able to approve its
// own irreversible action. Transport details (token lookup, fetch wrapper, response mapping) live
// in `./inboxTransport` and are re-exported here so importers have one entry point.
//
// Response contracts (the server mounts these under /api; P3 wiring):
//   GET  /api/inbox                        -> { items: InboxItem[] } | InboxItem[]
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

/** Items waiting for the operator, newest state first as the server orders them. */
export async function listInbox(opts: RequestOptions = {}): Promise<InboxItem[]> {
  const body = await request<unknown>(INBOX_PATH, { method: 'GET', signal: opts.signal })
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
      ? ((body as { items: unknown[] }).items)
      : null
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
  getApprovalChallenge,
  requestApproval,
  decideApproval,
  consumeApproval,
}
