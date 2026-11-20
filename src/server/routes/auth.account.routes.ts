// Account half of `/auth/*` (auth.routes.ts dispatches here): first-account setup, the caller's
// sessions, and password / username changes. Pattern: code-server / GitHub "sessions" page: a user sees
// and revokes only their own sessions, a password change signs every other device out (OWASP ASVS 3.3).
//   POST /auth/setup                      { username, password } -> 201 { user } + fresh cookie
//   GET  /auth/sessions                   { items: [{ id, createdAt, lastSeen, ua, current }] }
//   POST /auth/sessions/revoke-others     { revoked }
//   POST /auth/sessions/:id/revoke        204 (12-hex id, the caller's own sessions only)
//   POST /auth/account/password           { current, next }  -> 200, other sessions revoked
//   POST /auth/account/username           { username, password } -> 200 { user }
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../logs'
import { throttleKeys, type LoginThrottle } from '../loginThrottle'
import { AuthError, USERNAME_RE, checkPassword, type UiUser } from '../uiUser'
import { callerSession, readJsonBody, reply, sessionCookie, str, userAgentOf, type UiAuthDeps } from './auth.http'

const log = createLogger('auth')
const SESSION_ID_LEN = 12
const REVOKE_ONE = /^POST \/auth\/sessions\/([0-9a-f]{12})\/revoke$/
const ERROR_STATUS: Record<AuthError['code'], number> = {
  already_setup: 409, invalid_username: 400, username_taken: 409, weak_password: 400, invalid_credentials: 401, not_found: 404,
}

/** The account as the UI sees it: no timestamps, never a hash. */
export const publicUser = (u: UiUser): { id: number; username: string } => ({ id: u.id, username: u.username })

/** Public id of the caller's own session (same derivation as uiSession.ts `list()`). */
const sessionIdOf = (raw: string): string => createHash('sha256').update(raw).digest('hex').slice(0, SESSION_ID_LEN)

/** A new session for `user` (token-era when absent): the old cookie is revoked, never reused (no fixation). */
export function signIn(d: UiAuthDeps, req: IncomingMessage, res: ServerResponse, status: number, user?: UiUser): void {
  const old = callerSession(req)
  if (old !== undefined) d.sessions().revoke(old)
  const raw = d.sessions().create({ userId: user?.id, ua: userAgentOf(req) })
  log.info('auth.session_created', 'UI session created', { via: user ? 'account' : 'token', userId: user?.id })
  reply(res, status, user ? { user: publicUser(user) } : undefined, { 'Set-Cookie': sessionCookie(req, raw) })
}

/** POST /auth/setup; the caller serialises calls (auth.routes.ts), so a race answers one 201 and one 409. */
export async function setupAccount(d: UiAuthDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const read = await readJsonBody(req)
  if (!read.ok) return reply(res, read.status, { error: read.error })
  const username = str(read.body, 'username')
  const password = str(read.body, 'password')
  if (d.users().count() > 0) return reply(res, 409, { error: 'already_setup' })
  if (!USERNAME_RE.test(username)) return reply(res, 400, { error: 'invalid_username' })
  try {
    checkPassword(password)
  } catch (e) {
    if (e instanceof AuthError) return reply(res, 400, { error: e.code })
    throw new Error('setup: password check failed', { cause: e })
  }
  // No proof of ownership: whoever reaches a fresh server first claims it (docs/decisions/ui-session-cookie.md).
  const user = await d.users().createOwner({ username, password })
  d.sessions().revokeAllExcept() // every token-era tab: they sign in to the new account
  signIn(d, req, res, 201, user)
  log.info('auth.setup_done', 'First account created', { userId: user.id })
}

/** Sessions, password and username routes; 404 for anything else under /auth/. */
export async function accountRoute(d: UiAuthDeps, req: IncomingMessage, res: ServerResponse, route: string, throttle: LoginThrottle): Promise<void> {
  const known = route === 'GET /auth/sessions' || route.startsWith('POST /auth/sessions/') || route.startsWith('POST /auth/account/')
  if (!known) return reply(res, 404, { error: 'not_found' })
  const raw = callerSession(req)
  if (raw === undefined || !d.sessions().verify(raw)) return reply(res, 401, { error: 'not_signed_in' })
  const userId = d.sessions().userOf(raw)
  const current = sessionIdOf(raw)
  // A user sees their own sessions; token-era (no account yet) sees the account-less ones.
  const mine = () => d.sessions().list().filter((s) => s.userId === userId)

  if (route === 'GET /auth/sessions') {
    return reply(res, 200, { items: mine().map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, ua: s.ua, current: s.id === current })) })
  }
  if (route === 'POST /auth/sessions/revoke-others') {
    const others = mine().filter((s) => s.id !== current)
    for (const s of others) d.sessions().revokeById(s.id)
    log.info('auth.sessions_revoked', 'Other UI sessions revoked', { userId, n: others.length })
    return reply(res, 200, { revoked: others.length })
  }
  const one = REVOKE_ONE.exec(route)
  if (one) {
    if (!mine().some((s) => s.id === one[1])) return reply(res, 404, { error: 'not_found' })
    d.sessions().revokeById(one[1]!)
    return reply(res, 204)
  }
  if (route !== 'POST /auth/account/password' && route !== 'POST /auth/account/username') return reply(res, 404, { error: 'not_found' })
  const user = userId === null ? null : d.users().get(userId)
  if (!user) return reply(res, 401, { error: 'not_signed_in' })
  const read = await readJsonBody(req)
  if (!read.ok) return reply(res, read.status, { error: read.error })
  const keys = throttleKeys(user.username, req.socket.remoteAddress)
  const verdict = throttle.check(keys)
  if (!verdict.ok) return reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)) })
  try {
    if (route === 'POST /auth/account/password') {
      await d.users().changePassword(user.id, str(read.body, 'current'), str(read.body, 'next'))
      d.sessions().revokeUser(user.id, raw)
      log.info('auth.password_changed', 'Password changed; other sessions revoked', { userId: user.id })
      throttle.succeed(keys)
      return reply(res, 200, { ok: true })
    }
    const renamed = await d.users().rename(user.id, str(read.body, 'username'), str(read.body, 'password'))
    log.info('auth.username_changed', 'Username changed', { userId: user.id })
    throttle.succeed(keys)
    return reply(res, 200, { user: publicUser(renamed) })
  } catch (e) {
    if (!(e instanceof AuthError)) throw new Error(`${route} for user ${user.id} failed`, { cause: e })
    if (e.code === 'invalid_credentials') {
      throttle.fail(keys)
      log.warn('auth.login_failed', 'Account change refused: wrong password', { userId: user.id })
    }
    return reply(res, ERROR_STATUS[e.code], { error: e.code })
  }
}
