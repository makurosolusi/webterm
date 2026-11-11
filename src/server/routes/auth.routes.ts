// `/auth/*`: how a browser gets its `wt_ui` session cookie. Routed BEFORE the /api credential gate
// (index.ts). Pattern: Jupyter (redirect file -> cookie), code-server (account login -> cookie). Every
// sign-in mints a FRESH session (no fixation). Secrets never appear in a response body or a log line.
//   GET  /auth/open?code=&next= one-time code (uiOpen.ts) -> Set-Cookie + 303 to a same-origin `next`
//   GET  /auth/me               { signedIn, setupRequired, user, tokenSignIn }
//   POST /auth/request-open     { next? } server opens a signed-in window on this machine; 1 per OPEN_INTERVAL_MS
//   POST /auth/login            { username, password }, or { token } while no account exists
//   POST /auth/logout           revokes the caller's session and clears the cookie
//   /auth/setup, /auth/sessions*, /auth/account/*  -> auth.account.routes.ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sameOrigin, tokensMatch } from '../auth'
import { firstHeader } from '../httpHeaders'
import { createLogger } from '../logs'
import { loginThrottle, throttleKeys } from '../loginThrottle'
import { AuthError } from '../uiUser'
import type { UiSessionStore } from '../uiSession'
import { accountRoute, publicUser, setupAccount, signIn } from './auth.account.routes'
import { callerSession, clearedCookie, readJsonBody, reply, replyText, safeNext, sessionCookie, str, userAgentOf, type UiAuthDeps } from './auth.http'

export type { UiAuthDeps } from './auth.http'

const log = createLogger('auth')

export const AUTH_PREFIX = '/auth/'
/** One server-opened window per this interval, whoever asks (the endpoint is unauthenticated). */
export const OPEN_INTERVAL_MS = 10_000
const INVALID_CODE_TEXT = 'This sign-in link is invalid or has expired. Open webterm again to get a new one.'

export function createUiAuthRoute(d: UiAuthDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const now = d.now ?? Date.now
  const throttle = d.throttle ?? loginThrottle
  let lastOpenAt = Number.NEGATIVE_INFINITY
  // ponytail: in-process queue, enough for one server process; INSERT ... WHERE NOT EXISTS (uiUser.ts) is the backstop.
  let setupQueue: Promise<unknown> = Promise.resolve()

  const open = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    // A navigation from the file:// redirect page is cross-site by fetch metadata: the code is the proof.
    if (!d.opener.consume(url.searchParams.get('code'))) return replyText(res, 403, INVALID_CODE_TEXT)
    // Local passwordless sign-in (decision, ui-session-cookie.md): bound to the account when there is exactly one.
    const user = d.users().sole()
    const raw = d.sessions().create({ userId: user?.id, ua: userAgentOf(req) })
    log.info('auth.session_created', 'UI session created from a sign-in window', { via: 'open', userId: user?.id })
    reply(res, 303, undefined, { Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': sessionCookie(req, raw) })
  }

  const me = (req: IncomingMessage, res: ServerResponse): void => {
    const raw = callerSession(req)
    const signedIn = raw !== undefined && d.sessions().verify(raw)
    const userId = signedIn ? d.sessions().userOf(raw) : null
    const user = userId === null ? null : d.users().get(userId)
    const setupRequired = d.users().count() === 0
    reply(res, 200, { signedIn, setupRequired, user: user ? publicUser(user) : null, tokenSignIn: setupRequired })
  }

  const requestOpen = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t = now()
    if (t - lastOpenAt < OPEN_INTERVAL_MS) {
      return reply(res, 429, { error: 'too_many_requests' }, { 'Retry-After': String(Math.ceil((OPEN_INTERVAL_MS - (t - lastOpenAt)) / 1000)) })
    }
    lastOpenAt = t
    // Optional `{ next }`: the page to land on. No/invalid body is not an error, it just lands on `/`.
    const read = await readJsonBody(req)
    const next = read.ok && typeof read.body.next === 'string' ? safeNext(read.body.next) : '/'
    await d.opener.open(firstHeader(req.headers.host), next)
    reply(res, 202, { opening: true })
  }

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const read = await readJsonBody(req)
    if (!read.ok) return reply(res, read.status, { error: read.error })
    if ('token' in read.body) {
      // The root token stays for machines (header); humans sign in with it only until the first account exists.
      if (d.users().count() > 0) return reply(res, 409, { error: 'token_sign_in_disabled' })
      const expected = d.token()
      if (expected === undefined) return reply(res, 409, { error: 'token_not_enabled' })
      const candidate = read.body.token
      if (typeof candidate !== 'string' || !tokensMatch(expected, candidate)) return reply(res, 403, { error: 'invalid_token' })
      return signIn(d, req, res, 204)
    }
    const username = str(read.body, 'username')
    // Socket peer only: X-Forwarded-For is whatever the client says.
    const keys = throttleKeys(username, req.socket.remoteAddress)
    const verdict = throttle.check(keys)
    if (!verdict.ok) return reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)) })
    const user = await d.users().verifyLogin(username, str(read.body, 'password'))
    if (!user) {
      throttle.fail(keys)
      log.warn('auth.login_failed', 'Sign-in refused: wrong username or password') // never the username (PII, enumeration)
      return reply(res, 401, { error: 'invalid_credentials' })
    }
    throttle.succeed(keys)
    signIn(d, req, res, 200, user)
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const route = `${req.method ?? 'GET'} ${url.pathname}`
    if (route === 'GET /auth/open') return open(req, res, url)
    if (route === 'GET /auth/me') return me(req, res)
    if (route === 'GET /auth/sessions') return accountRoute(d, req, res, route, throttle)
    // State-changing entries: a hostile page must not drive them (cross-site Origin / fetch metadata).
    if (!sameOrigin(req.headers)) return reply(res, 403, { error: 'origin' })
    if (route === 'POST /auth/request-open') return requestOpen(req, res)
    if (route === 'POST /auth/setup') {
      const run = setupQueue.then(() => setupAccount(d, req, res))
      setupQueue = run.catch(() => undefined) // only orders the queue; the error itself is handled by the caller below
      return run
    }
    if (route === 'POST /auth/login') return login(req, res)
    if (route === 'POST /auth/logout') {
      const raw = callerSession(req)
      if (raw !== undefined) d.sessions().revoke(raw)
      return reply(res, 204, undefined, { 'Set-Cookie': clearedCookie(req) })
    }
    return accountRoute(d, req, res, route, throttle)
  }

  return (req, res, url) => {
    if (!url.pathname.startsWith(AUTH_PREFIX)) return false
    dispatch(req, res, url).catch((err: unknown) => {
      // Another process created the account between our count() and INSERT.
      if (err instanceof AuthError && err.code === 'already_setup' && !res.headersSent) return reply(res, 409, { error: 'already_setup' })
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
