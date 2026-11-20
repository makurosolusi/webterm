// Browser side of the account half of `/auth/*` (src/server/routes/auth.account.routes.ts and the
// password login in auth.routes.ts). Every call resolves with the status, the server's error code and
// Retry-After, so each screen maps codes to its own sentences; only a network failure rejects.
// Passwords travel in the JSON body only, never in a URL or a log line.
import { AUTH_LOGIN_PATH, type AuthUser } from './transportToken'

export const AUTH_SETUP_PATH = '/auth/setup'
export const AUTH_SESSIONS_PATH = '/auth/sessions'
export const AUTH_REVOKE_OTHERS_PATH = '/auth/sessions/revoke-others'
export const AUTH_PASSWORD_PATH = '/auth/account/password'
export const AUTH_USERNAME_PATH = '/auth/account/username'
/** Revoke one of the caller's sessions by its public 12-hex id. */
export const authRevokePath = (id: string): string => `/auth/sessions/${encodeURIComponent(id)}/revoke`

/** One answer of an `/auth/*` call: status, the server's `error` code (if any), Retry-After seconds, body. */
export interface AuthReply {
  status: number
  ok: boolean
  error: string | null
  retryAfterS: number
  body: Record<string, unknown> | null
}

/** One signed-in browser of the current user (GET /auth/sessions). */
export interface AuthSession { id: string; createdAt: number; lastSeen: number; ua: string | null; current: boolean }

async function call(path: string, method: 'GET' | 'POST', payload?: unknown): Promise<AuthReply> {
  const init: RequestInit = payload === undefined
    ? { method, cache: 'no-store' }
    : { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  const res = await fetch(path, init)
  const text = res.status === 204 ? '' : await res.text()
  let body: Record<string, unknown> | null = null
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = null // a non-JSON answer (proxy error page): the status alone says what happened
    }
  }
  const retry = Number(res.headers.get('Retry-After'))
  return {
    status: res.status, ok: res.ok, error: typeof body?.error === 'string' ? body.error : null,
    retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 0, body,
  }
}

/** The `user` of a reply, when it carries one. */
export const replyUser = (r: AuthReply): AuthUser | null => {
  const u = r.body?.user as AuthUser | undefined
  return u && typeof u.id === 'number' && typeof u.username === 'string' ? u : null
}

/** POST /auth/login with username + password: 200 signed in, 401 invalid_credentials, 429 rate_limited. */
export const loginWithPassword = (username: string, password: string): Promise<AuthReply> =>
  call(AUTH_LOGIN_PATH, 'POST', { username, password })

/** POST /auth/setup: 201 account created and signed in; 409 already_setup, 400 invalid_username|weak_password. */
export const setupAccount = (username: string, password: string): Promise<AuthReply> =>
  call(AUTH_SETUP_PATH, 'POST', { username, password })

/** GET /auth/sessions: the caller's own sessions. Throws (naming the call) when refused or malformed. */
export async function fetchSessions(): Promise<AuthSession[]> {
  const r = await call(AUTH_SESSIONS_PATH, 'GET')
  if (!r.ok) throw new Error(`GET ${AUTH_SESSIONS_PATH} -> ${r.status}${r.error ? ` ${r.error}` : ''}`)
  const items = r.body?.items
  if (!Array.isArray(items)) throw new Error(`GET ${AUTH_SESSIONS_PATH}: malformed answer`)
  return items as AuthSession[]
}

/** POST /auth/sessions/:id/revoke: 204, or 404 when it is gone or not the caller's. */
export const revokeSession = (id: string): Promise<AuthReply> => call(authRevokePath(id), 'POST')

/** POST /auth/sessions/revoke-others: `{ revoked }`. */
export const revokeOtherSessions = (): Promise<AuthReply> => call(AUTH_REVOKE_OTHERS_PATH, 'POST')

/** POST /auth/account/password: 200 (other sessions signed out), 401 wrong current, 400 weak_password, 429. */
export const changePassword = (current: string, next: string): Promise<AuthReply> =>
  call(AUTH_PASSWORD_PATH, 'POST', { current, next })

/** POST /auth/account/username: 200 `{ user }`, 409 username_taken, 400 invalid_username, 401, 429. */
export const changeUsername = (username: string, password: string): Promise<AuthReply> =>
  call(AUTH_USERNAME_PATH, 'POST', { username, password })
