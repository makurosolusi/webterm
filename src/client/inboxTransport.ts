// Transport plumbing for the operator inbox: token lookup, fetch wrapper, and response mapping.
// Split out of `./inboxApi` so both files stay small; `./inboxApi` re-exports everything here.
//
// Every request carries the transport token (`x-webterm-token`), the same credential `./api` uses
// for /api/workspaces and /api/fs. It never uses a node capability (`x-webterm-capability`): an
// agent must not be able to approve its own irreversible action. Secrets are only ever placed in a
// request header: never in a URL, never in logs, and never in an error message.
import { TOKEN_HEADER } from './api'
import type {
  ApprovalChallenge,
  ApprovalStatus,
  InboxItem,
  InboxState,
} from './inboxTypes'
import { InboxApiError } from './inboxTypes'

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

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InboxApiError(`invalid ${field}`, 400, 'invalid_request')
  }
  return value
}

/** Request ids must be 8..128 chars on the control plane. `randomUUID` where available, with a
 *  local fallback for older webviews; both are random, neither is a secret. */
export function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const INBOX_STATES: readonly InboxState[] = ['needs_you', 'review', 'broken']

/** Validate one row. A malformed row is dropped rather than crashing the whole list: one bad
 *  entry must not hide every other action waiting for the operator. */
export function toItem(raw: unknown): InboxItem | null {
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
  // A task fence is a positive integer lease generation. Anything else is treated as absent: a
  // bogus value must not be forwarded into an approval request the server cannot consume.
  const fence =
    typeof row.fence === 'number' && Number.isInteger(row.fence) && row.fence > 0 ? row.fence : undefined
  return {
    id: row.id,
    kind: row.kind,
    state: state as InboxState,
    projectId,
    title: row.title,
    ageMs,
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(fence === undefined ? {} : { fence }),
  }
}

export function toChallenge(raw: unknown, fallback: { kind: string; projectId: string }): ApprovalChallenge {
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

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired']
