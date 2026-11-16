// Transport guards for the one entry point that hands out a real shell: the /ws upgrade
// (and /api, which touches the filesystem). Pure functions only — no server, no sockets —
// so every decision below is testable without binding a port.
//
// Two independent gates, because each closes a hole the other leaves open:
//
//  1. Origin. A browser does NOT apply the same-origin policy to WebSocket, so any hostile
//     page the user happens to open can `new WebSocket('ws://127.0.0.1:8700/ws')` and get a
//     shell. Binding loopback does nothing against that — the request comes FROM the user's
//     own machine. So an Origin that is present must name this server.
//  2. Credential. Every bind needs one, loopback included (a sandboxed agent can curl loopback):
//     the root token header, the `wt_ui` UI session cookie, or a node token on node-token paths.
//     Nothing is ever read from the query string (URLs end up in logs, history and Referer).
import crypto from 'node:crypto'
import { firstHeader } from './httpHeaders'
import { createLogger } from './logs'

const log = createLogger('auth')

/** Header the client sends the token in on API requests. This is
 *  the transport token, distinct from the per-node `x-webterm-node-token` agent-session header. */
export const TOKEN_HEADER = 'x-webterm-token'
/** Query parameter of the `/?token=` landing link, which the client trades for a cookie through
 *  POST /auth/login. The server never accepts it as a credential; the proxy strips it defensively. */
export const TOKEN_PARAM = 'token'
/** Header that carries a per-node capability token (`wcap_*`) to the control API. Root and
 *  node tokens never travel in this header, and it is never read from the query string. */
export const CAPABILITY_HEADER = 'x-webterm-capability'
/** HttpOnly session cookie of the webterm UI (routes/auth.routes.ts). Root-equivalent: the proxy
 *  strips it before a dev server sees the request, and it is never accepted cross-origin. */
export const UI_SESSION_COOKIE = 'wt_ui'

export const DEFAULT_HOST = '127.0.0.1'

type Headers = Record<string, string | string[] | undefined>

// Deliberately NOT including '0.0.0.0' / '::' — those are wildcards that accept every interface.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * MUTATES `process.env.WEBTERM_TOKEN` so it holds exactly the token this process enforces.
 * Children inherit the whole env (see `pty.ts` `cleanEnv`), so a raw ` s3cret ` would otherwise
 * leave two canonical forms around: the trimmed one `authorize` compares against, and the
 * untrimmed one a child expands from `$WEBTERM_TOKEN` — which then 403s. One form, one place.
 * Unset (rather than keep a whitespace-only leftover) when no token is enforced: a var that is
 * set makes children send a header we do not require, and the env would be lying about it.
 */
export function writeTokenToEnv(token: string | undefined): void {
  if (token === undefined) delete process.env.WEBTERM_TOKEN
  else process.env.WEBTERM_TOKEN = token
}

/** Constant-time compare. `timingSafeEqual` throws on a length mismatch, hence the guard — and
 *  the guard leaks only the length, which an attacker who chose the candidate already knows. */
export function tokensMatch(expected: string | undefined, candidate: string | null | undefined): boolean {
  if (expected === undefined) return false // fail closed: no configured secret proves nothing
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

/** Value of cookie `name` in a `Cookie` header; undefined when absent. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/**
 * Is this request same-origin? Same rule as the WebSocket origin gate (`wsOrigin.ts`) so the two cannot drift.
 *  - Origin present: its host must equal the request's own `Host`. A browser sets `Host` from the
 *    URL it dialled and `Origin` from the page — a hostile page cannot make the two agree.
 *  - `Origin: null` (sandboxed iframe, opaque redirect) and a malformed Origin are refused: they
 *    carry no provenance, so they cannot be shown to be ours.
 *  - Origin ABSENT means a non-browser client (curl, the CLI, the tests) — browsers always send
 *    one on a WS handshake, so the attack this gate exists for always has it. Allowed, unless the
 *    browser itself tells us otherwise via `Sec-Fetch-Site`; absent fetch metadata is allowed
 *    because older browsers omit it. Same-origin is necessary, never sufficient: a credential is
 *    still required, and the `/ws` PTY upgrade on the cookie requires the Origin PRESENT (`wsOrigin.ts`).
 */
export function sameOrigin(headers: Headers): boolean {
  const origin = firstHeader(headers['origin'])
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return false
    try {
      return new URL(origin).host === firstHeader(headers['host'])
    } catch {
      return false // unparseable Origin: refuse rather than guess
    }
  }
  const site = firstHeader(headers['sec-fetch-site'])
  return !(site === 'cross-site' || site === 'same-site')
}

/** Root-token decision for one request: same-origin AND the root token header. */
export function authorize(args: {
  headers: Headers
  expectedToken: string | undefined
}): boolean {
  if (!sameOrigin(args.headers)) return false
  return tokensMatch(args.expectedToken, firstHeader(args.headers[TOKEN_HEADER]))
}

/**
 * Path yang boleh dilayani dengan token NODE (per sesi agent) alih-alih token root.
 *
 * Sengaja sempit: hanya jalur yang memang dipanggil hook dari dalam sesi agent — status hook,
 * context-link, control API, dan registry `/api/tools` milik CLI `webterm` (yang membuktikan node
 * dari token itu sendiri dan menggerbangi tiap panggilan lewat policy). Semua yang menyentuh setelan, workspace, filesystem, generator
 * nama, atau shell (`/ws`) TETAP butuh token root: token node bocor ke disk sesi agent mana pun,
 * dan satu sesi tidak boleh bisa menyetel ulang server atau membuka PTY milik sesi lain.
 */
export function isNodeTokenPath(pathname: string): boolean {
  return (
    pathname === '/api/agent-status' ||
    pathname === '/api/context-link' ||
    pathname.startsWith('/api/control/') ||
    pathname === '/api/tools' ||
    pathname.startsWith('/api/tools/')
  )
}

/** Keluarga control API, satu-satunya jalur yang boleh menerima capability token. Sengaja
 *  memakai prefix ber-trailing-slash supaya `/api/control` sendiri bukan anggota keluarga. */
export function isControlPath(pathname: string): boolean {
  return pathname.startsWith('/api/control/')
}

/**
 * Gerbang lengkap satu request: token root dulu, dan hanya bila itu gagal, token node untuk
 * `isNodeTokenPath` — dengan syarat origin tetap lolos. Token root tetap menang; tanpa kredensial
 * apa pun (cookie UI, token root/node, capability) request ditolak, loopback juga.
 */
export function authorizeRequest(args: {
  headers: Headers
  expectedToken: string | undefined
  pathname: string
  /** Validator token node (disuntikkan supaya modul ini tetap bebas state server). */
  isNodeToken: (token: string) => boolean
  /** Validator capability token (`wcap_*`). Tidak wajib: tanpa ini control API tetap
   *  root/node-only, yang merupakan perilaku aman bawaan. */
  isCapabilityToken?: (token: string) => boolean
  /** Validator of the `wt_ui` session cookie value. Optional: without it no cookie is accepted. */
  isUiSession?: (value: string) => boolean
}): boolean {
  if (authorize(args)) return true
  if (!sameOrigin(args.headers)) return false
  // Cookies ignore ports (RFC 6265): a page on the proxy port carries `wt_ui` too, so the cookie only
  // counts after the same-origin check above (Origin host = Host, no `Sec-Fetch-Site: same-site`).
  const session = readCookie(firstHeader(args.headers['cookie']), UI_SESSION_COOKIE)
  if (session && args.isUiSession?.(session)) return true
  if (isNodeTokenPath(args.pathname)) {
    const candidate = firstHeader(args.headers[TOKEN_HEADER])
    if (typeof candidate === 'string' && candidate !== '' && args.isNodeToken(candidate)) return true
  }
  // Capability: HANYA untuk keluarga control API, HANYA dari header (seperti semua kredensial di
  // sini). Jalur lain (settings/workspaces/fs//ws) tetap root-only.
  if (!isControlPath(args.pathname) || args.isCapabilityToken === undefined) return false
  const capability = firstHeader(args.headers[CAPABILITY_HEADER])
  if (typeof capability !== 'string' || capability === '') return false
  return args.isCapabilityToken(capability)
}

export type DenyReason = 'origin' | 'token'
/** Why `authorize` said no: a foreign Origin, or a missing/wrong token. */
export function denyReason(headers: Headers, expectedToken: string | undefined): DenyReason {
  return sameOrigin(headers) && !tokensMatch(expectedToken, firstHeader(headers[TOKEN_HEADER])) ? 'token' : 'origin'
}

/** Record a refused request (`auth.reject`): path and reason only, never the token. */
export function logAuthReject(pathname: string, reason: DenyReason): void {
  log.warn('auth.reject', `Rejected request to ${pathname} (${reason})`, { path: pathname, reason })
}

/** Record that a token-protected surface accepted a credential (`auth.login`); value never logged. */
export function logAuthLogin(pathname: string): void {
  log.debug('auth.login', `Authorized request to ${pathname}`, { path: pathname })
}
