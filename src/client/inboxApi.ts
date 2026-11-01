// Client for the operator inbox and the blocking approval queue.
//
// This is the HUMAN surface: every request carries the transport token (`x-webterm-token`), the
// same credential `./api` uses for /api/workspaces and /api/fs. It never uses a node capability
// (`x-webterm-capability`): an agent must not be able to approve its own irreversible action.
// Secrets are only ever placed in a request header: never in a URL, never in logs, and never in
// an error message.
//
// Token handling mirrors `./api` (see `readToken` below): the URL carries `?token=` once on page
// load, `./api` moves it into sessionStorage, and every later request reads it from there.
//
// Response contracts (the server mounts these under /api; P3 wiring):
//   GET  /api/inbox                        -> { items: InboxItem[] } | InboxItem[]
//   POST /api/control/approval/request     -> ApprovalChallenge
//   POST /api/control/approval/decide      -> ApprovalDecision
//   POST /api/control/approval/consume     -> ApprovalConsumeResult
import { TOKEN_HEADER } from './api'
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
  InboxState,
  RequestOptions,
} from './inboxTypes'
import { InboxApiError } from './inboxTypes'

export * from './inboxTypes'

export const INBOX_PATH = '/api/inbox'
/** Human approval surface: transport-token/loopback auth, never an agent capability. */
export const APPROVAL_PATH = '/api/approvals'

/** Must match TOKEN_PARAM / TOKEN_KEY in `./api`. Duplicated on purpose: importing `./api` for
 *  the values would also run its module-level URL cleanup, and this module must be usable in a
 *  test that fakes `location` without the side effect. */
const TOKEN_PARAM = 'token'
const TOKEN_KEY = 'webterm.token'

/** True for a fetch/AbortController abort. Aborts are cancellations, not failures to display. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Human-facing message for anything the client can throw. Deliberately short: the dialog shows it
 * in a live region, and a stack trace or raw response body there would be noise (and could echo
 * server internals). Unknown errors get a generic sentence.
 */
export function inboxErrorMessage(error: unknown): string {
  if (error instanceof InboxApiError) {
    if (error.status === 401 || error.status === 403) return 'Not allowed. Reload and sign in again.'
    if (error.code === 'digest_mismatch') return 'The action changed since this challenge was issued. Request a new one.'
    if (error.code === 'nonce_mismatch' || error.code === 'nonce_reused') return 'This challenge is no longer valid. Request a new one.'
    if (error.code === 'digest_mismatch_server') return 'The action changed. Request a new one.'
    if (error.code === 'expired' || error.code === 'approval_expired') return 'This challenge expired. Request a new one.'
    if (error.code === 'approval_not_pending') return 'This approval was already decided.'
    if (error.code === 'approval_not_found') return 'This approval no longer exists.'
    if (error.code === 'not_consumable') return 'This approval cannot be consumed (not approved, expired, or used).'
    return error.message
  }
  if (error instanceof TypeError) return 'Could not reach the server.'
  return 'Something went wrong. Try again.'
}

/** Same source order as `./api`: the one-time URL parameter wins, sessionStorage is the fallback. */
function readToken(): string {
  try {
    if (typeof location !== 'undefined' && typeof location.href === 'string') {
      const fromUrl = new URL(location.href).searchParams.get(TOKEN_PARAM)
      if (fromUrl !== null && fromUrl !== '') return fromUrl
    }
  } catch {
    // Malformed location in an exotic embedding: fall through to sessionStorage.
  }
  try {
    return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private mode / blocked site data makes the access itself throw. Token-free loopback still
    // works; a token-protected server will answer 401 and the panel shows that.
    return ''
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object') {
      const code = (body as { error?: unknown }).error
      if (typeof code === 'string' && code !== '') return code
    }
  } catch {
    // Non-JSON error body (proxy page, empty 502): the status is the only signal.
  }
  return `http_${res.status}`
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  const token = readToken()
  if (token !== '') headers[TOKEN_HEADER] = token

  // No `credentials` override: this is a same-origin app and the token travels in the header.
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const code = await errorCode(res)
    throw new InboxApiError(`${method} ${path} failed (${res.status} ${code})`, res.status, code)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch {
    throw new InboxApiError(`${method} ${path} returned invalid JSON`, 502, 'bad_response')
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InboxApiError(`invalid ${field}`, 400, 'invalid_request')
  }
  return value
}

/** Request ids must be 8..128 chars on the control plane. `randomUUID` where available, with a
 *  local fallback for older webviews; both are random, neither is a secret. */
function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const INBOX_STATES: readonly InboxState[] = ['needs_you', 'review', 'broken']

/** Validate one row. A malformed row is dropped rather than crashing the whole list: one bad
 *  entry must not hide every other action waiting for the operator. */
function toItem(raw: unknown): InboxItem | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  // `state` is this client's contract; `category` is the server projection's name for it.
  const state = row.state ?? row.category
  const projectId = typeof row.projectId === 'string' ? row.projectId : ''
  const detail = typeof row.detail === 'string' ? row.detail : row.evidenceSummary
  if (typeof row.id !== 'string' || row.id === '') return null
  if (typeof row.kind !== 'string' || row.kind === '') return null
  if (typeof row.title !== 'string') return null
  if (typeof state !== 'string' || !INBOX_STATES.includes(state as InboxState)) return null
  const ageMs = typeof row.ageMs === 'number' && Number.isFinite(row.ageMs) && row.ageMs >= 0 ? row.ageMs : 0
  return {
    id: row.id,
    kind: row.kind,
    state: state as InboxState,
    projectId,
    title: row.title,
    ageMs,
    ...(typeof detail === 'string' ? { detail } : {}),
  }
}

function toChallenge(raw: unknown, fallback: { kind: string; projectId: string }): ApprovalChallenge {
  if (!raw || typeof raw !== 'object') throw new InboxApiError('Approval challenge missing', 502, 'bad_response')
  const row = raw as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = row[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const expiresAt = row.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new InboxApiError('Approval challenge missing expiresAt', 502, 'bad_response')
  }
  const id = text('id')
  const digest = text('digest')
  const nonce = text('nonce')
  if (!id || !digest || !nonce) {
    throw new InboxApiError('Approval challenge is missing id, digest or nonce', 502, 'bad_response')
  }
  return {
    id,
    digest,
    nonce,
    expiresAt,
    kind: text('kind') ?? fallback.kind,
    projectId: text('projectId') ?? fallback.projectId,
  }
}

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
  const challenge = toChallenge(body, { kind: 'approval', projectId: '' })
  if (!challenge) throw new InboxApiError('bad_response', 502, 'bad_response')
  return challenge
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
  const statuses: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired']
  if (typeof row.id !== 'string' || typeof status !== 'string' || !statuses.includes(status as ApprovalStatus)) {
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
