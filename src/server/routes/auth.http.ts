// Shared HTTP plumbing of the `/auth/*` routes (auth.routes.ts, auth.account.routes.ts): JSON replies
// that are never cached, the `wt_ui` cookie, the caller's session, capped JSON bodies, and the
// open-redirect guard for `/auth/open?next=`. No secret ever goes into a reply body or a log line.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { UI_SESSION_COOKIE, readCookie } from '../auth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { firstHeader } from '../httpHeaders'
import type { LoginThrottle } from '../loginThrottle'
import type { UiOpener } from '../uiOpen'
import type { UiSessionStore } from '../uiSession'
import type { UserStore } from '../uiUser'

/** Browsers cap cookie lifetime at 400 days; the server's idle expiry (uiSession.ts) is what ends a session. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
const BODY_MAX_BYTES = 4096
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const

/** Write a JSON (or empty) reply that no cache or Referer keeps. */
export function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...NO_STORE, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/** Plain-text reply (a navigation, not a fetch). */
export function replyText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** `Secure` only when a TLS front says the browser is on https; plain http on loopback must keep the cookie. */
export function sessionCookie(req: IncomingMessage, value: string): string {
  const secure = firstHeader(req.headers['x-forwarded-proto']) === 'https' ? '; Secure' : ''
  return `${UI_SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`
}

/** Set-Cookie value that deletes `wt_ui`. */
export const clearedCookie = (req: IncomingMessage): string => sessionCookie(req, '').replace(/Max-Age=\d+/, 'Max-Age=0')

/** Raw `wt_ui` value the caller sent, if any (unverified). */
export const callerSession = (req: IncomingMessage): string | undefined => readCookie(firstHeader(req.headers.cookie), UI_SESSION_COOKIE)

/** User-Agent to store on a new session (the store truncates it; it is never logged). */
export const userAgentOf = (req: IncomingMessage): string | undefined => firstHeader(req.headers['user-agent'])

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }

/** Read a small JSON object body; anything else is a 400/413 the caller replies with. */
export async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
  if (!read.ok) return { ok: false, status: read.reason === 'too_large' ? 413 : 400, error: read.reason }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.body)
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' } // malformed input is the client's error, answered as such
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, status: 400, error: 'invalid_json' }
  return { ok: true, body: parsed as Record<string, unknown> }
}

/** String field of a parsed body, '' when absent or not a string (validation then refuses it). */
export const str = (body: Record<string, unknown>, key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '')

/**
 * Where `/auth/open` may send the browser: a same-origin path only. `//host`, `/\host` (browsers read
 * `\` as `/`), a scheme or a control character would leave the origin, so they fall back to `/`.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/'
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/'
  return next
}

/** What the `/auth/*` routes need; index.ts wires the production stores, tests pass in-memory ones. */
export interface UiAuthDeps {
  sessions: () => UiSessionStore
  users: () => UserStore
  opener: UiOpener
  /** Root token in force (every boot mints one; undefined only before boot, when token sign-in refuses). */
  token: () => string | undefined
  /** Data dir holding `secrets/SETUP_CODE`. */
  dataDir: () => string
  throttle?: LoginThrottle
  now?: () => number
}
