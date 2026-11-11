// The browser side of `/auth/*` (src/server/routes/auth.routes.ts). The UI's only credential is the
// HttpOnly `wt_ui` session cookie, which every same-origin fetch, WebSocket and EventSource already
// sends; no client code ever attaches a token. A legacy `/?token=…` landing link is traded once for
// the cookie only while no account exists (`tokenSignIn`); afterwards humans sign in with an account
// (account.api.client.ts) and the parameter is stripped and ignored.

/** Must match TOKEN_PARAM in src/server/auth.ts. */
export const TOKEN_PARAM = 'token'
export const AUTH_ME_PATH = '/auth/me'
export const AUTH_LOGIN_PATH = '/auth/login'
export const AUTH_LOGOUT_PATH = '/auth/logout'
export const AUTH_REQUEST_OPEN_PATH = '/auth/request-open'

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** The account as the UI sees it (GET /auth/me, POST /auth/login|setup). */
export interface AuthUser { id: number; username: string }
/** GET /auth/me: session state; `setupRequired` = no account yet, `tokenSignIn` = token sign-in still allowed. */
export interface AuthMe { signedIn: boolean; setupRequired: boolean; user: AuthUser | null; tokenSignIn: boolean }

const isUser = (v: unknown): v is AuthUser =>
  !!v && typeof v === 'object' && typeof (v as AuthUser).id === 'number' && typeof (v as AuthUser).username === 'string'

/** This browser's session state. Throws (naming the call) on a non-2xx answer. */
export async function fetchMe(signal?: AbortSignal): Promise<AuthMe> {
  const res = await fetch(AUTH_ME_PATH, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`GET ${AUTH_ME_PATH} -> ${res.status}`)
  const b = (await res.json()) as Record<string, unknown>
  return { signedIn: b.signedIn === true, setupRequired: b.setupRequired === true, user: isUser(b.user) ? b.user : null, tokenSignIn: b.tokenSignIn === true }
}

/** Whether this browser holds a live session. Throws (naming the call) on a non-2xx answer. */
export async function fetchSignedIn(signal?: AbortSignal): Promise<boolean> {
  return (await fetchMe(signal)).signedIn
}

/** The path a sign-in should come back to: where the user was (path + query + hash). */
export const currentPath = (): string => location.pathname + location.search + location.hash

/** POST the access token; resolves with the HTTP status (204 = signed in, 403 = wrong token). */
async function loginWithToken(token: string): Promise<number> {
  const res = await fetch(AUTH_LOGIN_PATH, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token }) })
  return res.status
}

/** Ask the server to open a signed-in window on its machine (landing on `next`); resolves with the status and Retry-After seconds. */
export async function requestOpen(next: string = currentPath()): Promise<{ status: number; retryAfterS: number }> {
  const res = await fetch(AUTH_REQUEST_OPEN_PATH, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ next }) })
  const retry = Number(res.headers.get('Retry-After'))
  return { status: res.status, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 0 }
}

/** End this browser's session. Throws (naming the call) when the server refuses. */
export async function logout(): Promise<void> {
  const res = await fetch(AUTH_LOGOUT_PATH, { method: 'POST' })
  if (!res.ok) throw new Error(`POST ${AUTH_LOGOUT_PATH} -> ${res.status}`)
}

/**
 * Trade a `?token=` landing parameter for the session cookie while no account exists. The parameter
 * leaves the address bar first, so it is never bookmarked or screenshotted; once an account exists
 * (`tokenSignIn` false) it is only stripped. Never rejects: a refused or unreachable exchange leaves
 * the page signed out, and the sign-in screen shows that state.
 */
export async function exchangeLandingToken(): Promise<void> {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const url = new URL(location.href)
  const token = url.searchParams.get(TOKEN_PARAM)
  if (token === null) return
  url.searchParams.delete(TOKEN_PARAM)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  if (token === '') return
  try {
    if (!(await fetchMe()).tokenSignIn) return // an account exists: humans sign in with it, not the token
    const status = await loginWithToken(token)
    if (status !== 204) console.warn(`[webterm] sign-in link refused (POST ${AUTH_LOGIN_PATH} -> ${status})`)
  } catch (error) {
    console.warn(`[webterm] sign-in link exchange failed (POST ${AUTH_LOGIN_PATH})`, error)
  }
}

/** True for a fetch/AbortController abort. Aborts are cancellations, not failures to display. */
export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}
