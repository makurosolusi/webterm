// The browser side of `/auth/*` (src/server/routes/auth.routes.ts). The UI's only credential is the
// HttpOnly `wt_ui` session cookie, which every same-origin fetch, WebSocket and EventSource already
// sends; no client code ever attaches a token. The one place a token still appears in a URL is a
// `/?token=…` landing link (TokenAccessCard): exchangeLandingToken trades it once for the cookie.

/** Must match TOKEN_PARAM in src/server/auth.ts. */
export const TOKEN_PARAM = 'token'
export const AUTH_ME_PATH = '/auth/me'
export const AUTH_LOGIN_PATH = '/auth/login'
export const AUTH_LOGOUT_PATH = '/auth/logout'
export const AUTH_REQUEST_OPEN_PATH = '/auth/request-open'

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** Whether this browser holds a live session. Throws (naming the call) on a non-2xx answer. */
export async function fetchSignedIn(signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(AUTH_ME_PATH, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`GET ${AUTH_ME_PATH} -> ${res.status}`)
  const body = (await res.json()) as { signedIn?: unknown }
  return body.signedIn === true
}

/** POST the access token; resolves with the HTTP status (204 = signed in, 403 = wrong token). */
export async function loginWithToken(token: string): Promise<number> {
  const res = await fetch(AUTH_LOGIN_PATH, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token }) })
  return res.status
}

/** Ask the server to open a signed-in window on its machine; resolves with the status and Retry-After seconds. */
export async function requestOpen(): Promise<{ status: number; retryAfterS: number }> {
  const res = await fetch(AUTH_REQUEST_OPEN_PATH, { method: 'POST' })
  const retry = Number(res.headers.get('Retry-After'))
  return { status: res.status, retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 0 }
}

/** End this browser's session. Throws (naming the call) when the server refuses. */
export async function logout(): Promise<void> {
  const res = await fetch(AUTH_LOGOUT_PATH, { method: 'POST' })
  if (!res.ok) throw new Error(`POST ${AUTH_LOGOUT_PATH} -> ${res.status}`)
}

/**
 * Trade a `?token=` landing parameter for the session cookie. The parameter leaves the address bar
 * first, so it is never bookmarked or screenshotted. Never rejects: a refused or unreachable
 * exchange leaves the page signed out, and the sign-in screen shows that state.
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
