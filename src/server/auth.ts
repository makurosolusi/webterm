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
//  2. Token. Only needed when we are reachable from outside the machine; loopback-only stays
//     token-free so the default dev loop is untouched.
import crypto from 'node:crypto'
import { firstHeader } from './httpHeaders'
import { createLogger } from './logs'

const log = createLogger('auth')

/** Header the client sends the token in on API requests. `webterm`, not `nodeterm`: this is
 *  our own transport token, unrelated to the `x-nodeterm-node-token` agent-session protocol. */
export const TOKEN_HEADER = 'x-webterm-token'
/** Query parameter carrying the token on the initial page load and on the WS URL (a browser
 *  cannot set headers on `new WebSocket`, so the WS handshake has no other place to put it). */
export const TOKEN_PARAM = 'token'
/** Header that carries a per-node capability token (`wcap_*`) to the control API. Root and
 *  node tokens never travel in this header, and it is never read from the query string. */
export const CAPABILITY_HEADER = 'x-webterm-capability'

export const DEFAULT_HOST = '127.0.0.1'

type Headers = Record<string, string | string[] | undefined>

// Deliberately NOT including '0.0.0.0' / '::' — those are wildcards that accept every
// interface, which is the exact case the token requirement exists for.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/** A token is mandatory exactly when the bind host can be reached from off-machine. */
export function requiresToken(host: string): boolean {
  return !isLoopbackHost(host)
}

/**
 * The token this process will enforce, or `undefined` for the token-free loopback default.
 * Throws when the host is reachable from outside and no token was configured — refusing to
 * start is the only safe outcome there, an open shell on the LAN is not a degraded mode.
 */
export function resolveToken(host: string, raw: string | undefined): string | undefined {
  const token = (raw ?? '').trim()
  if (token !== '') return token
  if (requiresToken(host)) {
    throw new Error(
      `HOST="${host}" is reachable from other machines, which would expose a full shell. ` +
        `Set WEBTERM_TOKEN to a long random secret, or use a loopback HOST (localhost/127.0.0.1/::1).`
    )
  }
  return undefined
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
  if (expected === undefined) return true // no token configured: nothing to prove
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
}

/**
 * Is this request same-origin? Mirrors nodeterm's `src/server/origin.ts` so the two cannot drift.
 *  - Origin present: its host must equal the request's own `Host`. A browser sets `Host` from the
 *    URL it dialled and `Origin` from the page — a hostile page cannot make the two agree.
 *  - `Origin: null` (sandboxed iframe, opaque redirect) and a malformed Origin are refused: they
 *    carry no provenance, so they cannot be shown to be ours.
 *  - Origin ABSENT means a non-browser client (curl, the CLI, the tests) — browsers always send
 *    one on a WS handshake, so the attack this gate exists for always has it. Allowed, unless the
 *    browser itself tells us otherwise via `Sec-Fetch-Site`; absent fetch metadata is allowed
 *    because older browsers omit it.
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

/** The whole decision for one request: same-origin AND (no token required, or the right token). */
export function authorize(args: {
  headers: Headers
  expectedToken: string | undefined
  queryToken?: string | null
}): boolean {
  if (!sameOrigin(args.headers)) return false
  const candidate = firstHeader(args.headers[TOKEN_HEADER]) ?? args.queryToken
  return tokensMatch(args.expectedToken, candidate)
}

/**
 * Path yang boleh dilayani dengan token NODE (per sesi agent) alih-alih token root.
 *
 * Sengaja sempit: hanya jalur yang memang dipanggil hook dari dalam sesi agent — status hook,
 * context-link, dan control API. Semua yang menyentuh setelan, workspace, filesystem, generator
 * nama, atau shell (`/ws`) TETAP butuh token root: token node bocor ke disk sesi agent mana pun,
 * dan satu sesi tidak boleh bisa menyetel ulang server atau membuka PTY milik sesi lain.
 */
export function isNodeTokenPath(pathname: string): boolean {
  return (
    pathname === '/api/agent-status' ||
    pathname === '/api/context-link' ||
    pathname.startsWith('/api/control/')
  )
}

/** Keluarga control API, satu-satunya jalur yang boleh menerima capability token. Sengaja
 *  memakai prefix ber-trailing-slash supaya `/api/control` sendiri bukan anggota keluarga. */
export function isControlPath(pathname: string): boolean {
  return pathname.startsWith('/api/control/')
}

/**
 * Gerbang lengkap satu request: token root dulu, dan hanya bila itu gagal, token node untuk
 * `isNodeTokenPath` — dengan syarat origin tetap lolos. Urutan ini penting supaya perilaku
 * root tidak berubah sama sekali (loopback tanpa token tetap terbuka; token root tetap menang).
 */
export function authorizeRequest(args: {
  headers: Headers
  expectedToken: string | undefined
  queryToken?: string | null
  pathname: string
  /** Validator token node (disuntikkan supaya modul ini tetap bebas state server). */
  isNodeToken: (token: string) => boolean
  /** Validator capability token (`wcap_*`). Tidak wajib: tanpa ini control API tetap
   *  root/node-only, yang merupakan perilaku aman bawaan. */
  isCapabilityToken?: (token: string) => boolean
}): boolean {
  if (authorize(args)) return true
  if (!sameOrigin(args.headers)) return false
  if (isNodeTokenPath(args.pathname)) {
    const candidate = firstHeader(args.headers[TOKEN_HEADER]) ?? args.queryToken
    if (typeof candidate === 'string' && candidate !== '' && args.isNodeToken(candidate)) return true
  }
  // Capability: HANYA untuk keluarga control API, HANYA dari header. Query string tidak pernah
  // diperiksa — capability yang bocor ke URL akan tercatat di log/riwayat, dan gate ini tidak
  // boleh jadi jalan masuknya. Jalur lain (settings/workspaces/fs//ws) tetap root-only.
  if (!isControlPath(args.pathname) || args.isCapabilityToken === undefined) return false
  const capability = firstHeader(args.headers[CAPABILITY_HEADER])
  if (typeof capability !== 'string' || capability === '') return false
  return args.isCapabilityToken(capability)
}

/** Why `authorize` said no: a foreign Origin, or a missing/wrong token. */
export function denyReason(headers: Headers, expectedToken: string | undefined, queryToken?: string | null): 'origin' | 'token' {
  return sameOrigin(headers) && !tokensMatch(expectedToken, firstHeader(headers[TOKEN_HEADER]) ?? queryToken) ? 'token' : 'origin'
}

/** Record a refused request (`auth.reject`): path and reason only, never the token or headers. */
export function logAuthReject(pathname: string, reason: 'origin' | 'token'): void {
  log.warn('auth.reject', `Rejected request to ${pathname} (${reason})`, { path: pathname, reason })
}

/** Record that a token-protected surface accepted a credential (`auth.login`); value never logged. */
export function logAuthLogin(pathname: string): void {
  log.debug('auth.login', `Authorized request to ${pathname}`, { path: pathname })
}
