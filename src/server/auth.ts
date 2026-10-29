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

/** Header the client sends the token in on API requests. `webterm`, not `nodeterm`: this is
 *  our own transport token, unrelated to the `x-nodeterm-node-token` agent-session protocol. */
export const TOKEN_HEADER = 'x-webterm-token'
/** Query parameter carrying the token on the initial page load and on the WS URL (a browser
 *  cannot set headers on `new WebSocket`, so the WS handshake has no other place to put it). */
export const TOKEN_PARAM = 'token'

export const DEFAULT_HOST = '127.0.0.1'

type Headers = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

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
  const origin = first(headers['origin'])
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return false
    try {
      return new URL(origin).host === first(headers['host'])
    } catch {
      return false // unparseable Origin: refuse rather than guess
    }
  }
  const site = first(headers['sec-fetch-site'])
  return !(site === 'cross-site' || site === 'same-site')
}

/** The whole decision for one request: same-origin AND (no token required, or the right token). */
export function authorize(args: {
  headers: Headers
  expectedToken: string | undefined
  queryToken?: string | null
}): boolean {
  if (!sameOrigin(args.headers)) return false
  const candidate = first(args.headers[TOKEN_HEADER]) ?? args.queryToken
  return tokensMatch(args.expectedToken, candidate)
}
