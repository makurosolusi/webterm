// `/auth/*`: the entry points that hand the webterm UI its `wt_ui` session cookie. Routed BEFORE
// the /api credential gate (index.ts) because they are how a browser gets a credential; each checks
// the Host allowlist itself. Pattern: Jupyter (redirect file + token -> cookie) and VS Code server
// (cookie set, then 303 to a clean URL). Secrets never appear in a response body or a log line.
//   GET  /auth/open?code=   one-time code (uiOpen.ts) -> Set-Cookie + 303 `/`
//   GET  /auth/me           { signedIn } (polled by a signed-out tab)
//   POST /auth/request-open server opens a signed-in window on this machine; 1 per OPEN_INTERVAL_MS
//   POST /auth/login        { token } root token -> Set-Cookie (remote / headless sign-in)
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type AllowedHostsArg, UI_SESSION_COOKIE, hostOk, readCookie, sameOrigin, tokensMatch } from '../auth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { firstHeader } from '../httpHeaders'
import { createLogger } from '../logs'
import type { UiOpener } from '../uiOpen'
import type { UiSessionStore } from '../uiSession'

const log = createLogger('auth')

export const AUTH_PREFIX = '/auth/'
/** One server-opened window per this interval, whoever asks (the endpoint is unauthenticated). */
export const OPEN_INTERVAL_MS = 10_000
/** Browsers cap cookie lifetime at 400 days; the server's idle expiry (uiSession.ts) is what ends a session. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
const LOGIN_BODY_MAX_BYTES = 1024
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const
const INVALID_CODE_TEXT = 'This sign-in link is invalid or has expired. Open webterm again to get a new one.'

export interface UiAuthDeps {
  sessions: () => UiSessionStore
  opener: UiOpener
  hosts?: AllowedHostsArg
  /** Root token in force (undefined = token-free loopback bind: /auth/login has nothing to check). */
  token: () => string | undefined
  now?: () => number
}

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...NO_STORE, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/** `Secure` only when a TLS front says the browser is on https; plain http on loopback must keep the cookie. */
function sessionCookie(req: IncomingMessage, value: string): string {
  const secure = firstHeader(req.headers['x-forwarded-proto']) === 'https' ? '; Secure' : ''
  return `${UI_SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`
}

const callerSession = (req: IncomingMessage): string | undefined => readCookie(firstHeader(req.headers.cookie), UI_SESSION_COOKIE)

export function createUiAuthRoute(d: UiAuthDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const now = d.now ?? Date.now
  let lastOpenAt = Number.NEGATIVE_INFINITY

  const open = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    // A navigation from the file:// redirect page is cross-site by fetch metadata: the code is the proof.
    if (!d.opener.consume(url.searchParams.get('code'))) {
      res.writeHead(403, { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' })
      return void res.end(INVALID_CODE_TEXT)
    }
    log.info('auth.session_created', 'UI session created from a sign-in window', { via: 'open' })
    reply(res, 303, undefined, { Location: '/', 'Set-Cookie': sessionCookie(req, d.sessions().create()) })
  }

  const requestOpen = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t = now()
    if (t - lastOpenAt < OPEN_INTERVAL_MS) {
      return reply(res, 429, { error: 'too_many_requests' }, { 'Retry-After': String(Math.ceil((OPEN_INTERVAL_MS - (t - lastOpenAt)) / 1000)) })
    }
    lastOpenAt = t
    await d.opener.open(firstHeader(req.headers.host))
    reply(res, 202, { opening: true })
  }

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const read = await readCappedRequestBody(req, LOGIN_BODY_MAX_BYTES)
    if (!read.ok) return reply(res, read.reason === 'too_large' ? 413 : 400, { error: read.reason })
    const expected = d.token()
    if (expected === undefined) return reply(res, 409, { error: 'token_not_enabled' })
    let candidate: unknown
    try {
      candidate = (JSON.parse(read.body) as { token?: unknown }).token
    } catch {
      return reply(res, 400, { error: 'invalid_json' })
    }
    if (typeof candidate !== 'string' || !tokensMatch(expected, candidate)) return reply(res, 403, { error: 'invalid_token' })
    log.info('auth.session_created', 'UI session created from the access token', { via: 'login' })
    reply(res, 204, undefined, { 'Set-Cookie': sessionCookie(req, d.sessions().create()) })
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const route = `${req.method ?? 'GET'} ${url.pathname}`
    if (!hostOk(req.headers, d.hosts)) return reply(res, 403, { error: 'host_not_allowed' })
    if (route === 'GET /auth/open') return open(req, res, url)
    if (route === 'GET /auth/me') {
      const raw = callerSession(req)
      return reply(res, 200, { signedIn: raw !== undefined && d.sessions().verify(raw) })
    }
    // State-changing entries: a hostile page must not drive them (cross-site Origin / fetch metadata).
    if (!sameOrigin(req.headers)) return reply(res, 403, { error: 'origin' })
    if (route === 'POST /auth/request-open') return requestOpen(req, res)
    if (route === 'POST /auth/login') return login(req, res)
    reply(res, 404, { error: 'not_found' })
  }

  return (req, res, url) => {
    if (!url.pathname.startsWith(AUTH_PREFIX)) return false
    dispatch(req, res, url).catch((err: unknown) => {
      log.error('auth.route_failed', `Auth route failed: ${req.method ?? 'GET'} ${url.pathname}`, { cause: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) reply(res, 500, { error: 'internal' })
    })
    return true
  }
}

/** Token enable/rotate: every other session dies, the caller (if it holds one) stays signed in. */
export function revokeOtherSessions(sessions: () => UiSessionStore): (req: IncomingMessage) => void {
  return (req) => sessions().revokeAllExcept(callerSession(req))
}
