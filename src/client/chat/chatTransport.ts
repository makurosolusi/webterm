// Transport plumbing for the central chat client: route constants, the typed error, and the
// cookie-carrying JSON fetch. Split from `../chatApi` so each file stays inside the repo budget.
//
// Credential: the `wt_ui` session cookie, same as `../api` and `../inboxTransport`.
// Never a node capability, never `actor`, never a digest/nonce: web chat cannot approve.
import { isAbortError } from '../transportToken'

export { isAbortError }

export const CHAT_PATH = '/api/central'
/** Mirrors `CENTRAL_EVENT_TYPES` in `src/server/central/conversationModel.ts`. */
export const CHAT_EVENT_TYPES = [
  'message.created', 'part.delta', 'part.completed', 'tool.requested', 'tool.completed',
  'approval.requested', 'approval.updated', 'entity.updated', 'turn.status', 'error', 'done', 'notice',
] as const

/** Typed API failure. `code` is the server's stable error code; the message is not contract. */
export class ChatApiError extends Error {
  readonly status: number
  readonly code: string
  readonly activeTurnId: string | null

  constructor(message: string, status: number, code: string, activeTurnId: string | null = null) {
    super(message)
    this.name = 'ChatApiError'
    this.status = status
    this.code = code
    this.activeTurnId = activeTurnId
  }
}

/** Shown when the server's Claude Code runtime is missing or not logged in (code `runtime_unavailable`). */
export const RUNTIME_UNAVAILABLE_MESSAGE = 'Claude Code is not ready on the server (not installed or not logged in). Set up Claude in Settings › Agent › Claude launch profiles and press Test.'

/** Shown when Central has no engine (code `central_runtime_off`): Central runs on Claude only. */
export const CENTRAL_OFF_MESSAGE = 'Central needs Claude. Set up Claude in Settings › Agent › Claude launch profiles and press Test.'

/** Short human text; never echoes a response body (it could contain server internals). */
export function chatErrorMessage(error: unknown): string {
  if (error instanceof ChatApiError) {
    if (error.status === 401 || error.status === 403) return 'Not allowed. Reload and sign in again.'
    if (error.code === 'conversation_busy') return 'Another turn is running. Stop it or wait for it to finish.'
    if (error.code === 'central_runtime_off') return CENTRAL_OFF_MESSAGE
    if (error.code === 'runtime_unavailable') return RUNTIME_UNAVAILABLE_MESSAGE
    if (error.code === 'turn_not_active') return 'This turn already finished.'
    if (error.code === 'conversation_not_found') return 'This conversation no longer exists.'
    if (error.code === 'http_404') return 'Central chat is not enabled on this server.'
    if (error.code === 'central_chat_internal') return 'The server could not answer. Try again.'
    if (error.status >= 500) return 'The server could not answer. Try again.'
    return 'The message could not be sent.'
  }
  if (error instanceof TypeError) return 'Could not reach the server.'
  return 'Something went wrong. Try again.'
}

async function readError(res: Response): Promise<{ code: string; activeTurnId: string | null }> {
  try {
    const body: unknown = await res.json()
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    // The agent chat routes answer `{ error: '<code>', reason }` (a string code, see agentChat.route.core).
    if (typeof error === 'string' && error !== '') return { code: error, activeTurnId: null }
    if (error && typeof error === 'object') {
      const row = error as Record<string, unknown>
      return {
        code: typeof row.code === 'string' && row.code !== '' ? row.code : `http_${res.status}`,
        activeTurnId: typeof row.activeTurnId === 'string' ? row.activeTurnId : null,
      }
    }
  } catch {
    // Non-JSON error body: the status is the only signal.
  }
  return { code: `http_${res.status}`, activeTurnId: null }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  const method = (init.method ?? 'GET').toUpperCase()
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const { code, activeTurnId } = await readError(res)
    throw new ChatApiError(`${method} ${path} failed (${res.status} ${code})`, res.status, code, activeTurnId)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch {
    throw new ChatApiError(`${method} ${path} returned invalid JSON`, 502, 'bad_response')
  }
}
