// `/proxy/<port>/...` and `/absproxy/<port>/...`: open a dev server that runs next to webterm (vite on
// 5173, ...) from a phone or another machine. Served ONLY by the proxy listener (proxy.listener.ts) on
// its own port = its own browser origin: a dev server runs arbitrary npm code, and on webterm's origin
// its page could read the UI's token (= shell). The /api + /ws Origin gate refuses the proxy origin.
//
// Copied from code-server (`src/node/routes/pathProxy.ts`, docs "Accessing web services"):
//  - `/proxy/<port>/x` strips `/proxy/<port>` -> upstream sees `/x`; `/absproxy/<port>/x` passes the path
//    as is (frameworks with a configurable base, e.g. vite `base: '/absproxy/5173/'`, which is what
//    vite HMR needs: its client dials the base path, so the stripped form cannot carry HMR).
//  - every proxied request, WebSocket upgrades included, goes through the same auth + Origin check;
//  - its own origin for proxied pages, like code-server's `--proxy-domain` (here a port, not a subdomain: zero-config);
//  - an upstream `Location: /x` is rewritten to `/proxy/<port>/x` in strip mode.
// webterm additions: loopback-only target, port allowlist from the port sensor, never webterm's own
// port, no DNS (we dial the bind IP), hop-by-hop + webterm credential headers/cookie never reach upstream.
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { CAPABILITY_HEADER, TOKEN_HEADER, TOKEN_PARAM, UI_SESSION_COOKIE, readCookie, tokensMatch, type AllowedHostsArg } from '../auth'
import { isLoopbackOrUnspecified } from '../browser/ssrf.ip'
import { firstHeader } from '../httpHeaders'
import { hostAllowed } from '../hostAllow'
import { createLogger } from '../logs'

const log = createLogger('proxy')

/** HttpOnly cookie the proxy sets after a `?token=` hit, so sub-resources and the HMR socket (which
 *  carry no token) stay authorized. Holds an HMAC of the root token, never the token itself. */
export const PROXY_COOKIE = 'webterm_proxy'
const PORT_MAX = 65_535
const CONNECT_TIMEOUT_MS = 15_000
// RFC 9110 §7.6.1 hop-by-hop set (+ legacy proxy-connection); headers named in `Connection` go too.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
const WEBTERM_HEADERS = [TOKEN_HEADER, CAPABILITY_HEADER]

export interface ProxyDeps {
  allowedHosts?: AllowedHostsArg
  /** Root token in force right now (undefined = token-free loopback bind). */
  token(): string | undefined
  /** Listeners the port sensor has seen: the allowlist. */
  listening(): Promise<ReadonlyArray<{ port: number; host: string }>>
  /** webterm's main port: its origin may navigate here (Origin accepted); never proxied. */
  mainPort: number
  /** Ports never proxied: webterm's main port and the proxy listener's own. */
  selfPorts(): readonly number[]
}

export interface ProxyTarget { kind: 'proxy' | 'absproxy'; port: number; prefix: string; path: string; search: string }

/** Parse a raw request URL; null = not a proxy path. `path` is what upstream sees (undefined rest = no trailing slash). */
export function parseProxyUrl(rawUrl: string): (ProxyTarget & { bare: boolean }) | 'bad_port' | null {
  const q = rawUrl.indexOf('?')
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q)
  const m = /^\/(proxy|absproxy)\/([^/]*)(\/.*)?$/.exec(pathname)
  if (!m) return null
  const port = /^\d{1,5}$/.test(m[2]!) ? Number(m[2]) : NaN
  if (!(port >= 1 && port <= PORT_MAX)) return 'bad_port'
  const kind = m[1] as ProxyTarget['kind']
  const prefix = `/${kind}/${port}`
  return { kind, port, prefix, bare: m[3] === undefined, path: kind === 'proxy' ? (m[3] ?? '/') : pathname, search: dropTokenParam(q < 0 ? '' : rawUrl.slice(q + 1)) }
}

/** Raw query minus `token` (the root token must not reach the dev server); keeps the rest byte-for-byte. */
function dropTokenParam(query: string): string {
  const kept = query.split('&').filter((p) => p !== '' && safeDecode(p.split('=')[0]!) !== TOKEN_PARAM)
  return kept.length ? `?${kept.join('&')}` : ''
}
const safeDecode = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }

const cookieValue = (token: string): string => crypto.createHmac('sha256', token).update('webterm-proxy-cookie').digest('base64url')

/** webterm's own cookies: the proxy's and the UI session (cookies ignore ports, RFC 6265, so the
 *  browser sends `wt_ui` here too; an agent-started dev server must never receive it). */
const WEBTERM_COOKIES: ReadonlySet<string> = new Set([PROXY_COOKIE, UI_SESSION_COOKIE])

/** Cookie header minus webterm's own cookies; undefined when nothing is left. */
function stripWebtermCookie(header: string | undefined): string | undefined {
  const kept = (header ?? '').split(';').map((p) => p.trim()).filter((p) => p !== '' && !WEBTERM_COOKIES.has(p.split('=')[0]!.trim()))
  return kept.length ? kept.join('; ') : undefined
}

type Gate = { ok: true; setCookie: boolean } | { ok: false }

/**
 * `sameOrigin()` (auth.ts) widened by exactly one origin: webterm's main origin (same hostname, main
 * port) may navigate or open sockets here; the reverse is what /api refuses. Origin absent = non-browser
 * or a plain navigation: allowed unless `Sec-Fetch-Site: cross-site` (same-site = other ports of this
 * host). `requirePresent` = the /ws rule on a token-free bind (wsOrigin.ts): only a browser Origin proves the UI.
 */
export function proxyOriginOk(headers: IncomingMessage['headers'], mainPort: number, requirePresent: boolean): boolean {
  const origin = firstHeader(headers.origin)
  if (typeof origin !== 'string' || origin === '') return !requirePresent && firstHeader(headers['sec-fetch-site']) !== 'cross-site'
  try {
    const o = new URL(origin)
    const self = new URL(`http://${firstHeader(headers.host) ?? ''}`)
    if (o.host === self.host) return true
    return o.hostname === self.hostname && Number(o.port || (o.protocol === 'https:' ? 443 : 80)) === mainPort
  } catch {
    return false // `null` / unparseable Origin: no provenance
  }
}

function hostOk(headers: IncomingMessage['headers'], arg: AllowedHostsArg | undefined): boolean {
  const list = typeof arg === 'function' ? arg() : arg
  return list === undefined || hostAllowed(headers.host, list)
}

/** Host allowlist + `proxyOriginOk`; credential = root token (header/query, as /api) or the proxy cookie. */
function gate(req: IncomingMessage, token: string | undefined, deps: ProxyDeps, upgrade: boolean): Gate {
  if (!hostOk(req.headers, deps.allowedHosts) || !proxyOriginOk(req.headers, deps.mainPort, upgrade && token === undefined)) return { ok: false }
  if (token === undefined) return { ok: true, setCookie: false }
  const query = new URL(req.url ?? '/', 'http://x').searchParams.get(TOKEN_PARAM)
  if (tokensMatch(token, firstHeader(req.headers[TOKEN_HEADER]) ?? query)) return { ok: true, setCookie: true }
  return tokensMatch(cookieValue(token), readCookie(firstHeader(req.headers.cookie), PROXY_COOKIE)) ? { ok: true, setCookie: false } : { ok: false }
}

/** Bind address -> loopback IP to dial, or null when the listener is not loopback-reachable. */
function dialHost(bind: string): string | null {
  if (bind === '*' || bind === '0.0.0.0' || bind === '::') return '127.0.0.1'
  return isLoopbackOrUnspecified(bind) ? bind : null
}

type Resolved = { ok: true; ip: string } | { ok: false; status: number; reason: string }

async function resolveTarget(port: number, deps: ProxyDeps): Promise<Resolved> {
  if (deps.selfPorts().includes(port)) return { ok: false, status: 403, reason: 'port_not_allowed' }
  const seen = (await deps.listening()).filter((l) => l.port === port)
  if (seen.length === 0) return { ok: false, status: 403, reason: 'port_not_allowed' }
  const ip = seen.map((l) => dialHost(l.host)).find((h): h is string => h !== null)
  return ip ? { ok: true, ip } : { ok: false, status: 403, reason: 'non_loopback_target' }
}

/** Request headers for upstream: no hop-by-hop (unless `keepUpgrade`), no webterm credentials, Host/Origin = upstream. */
function upstreamHeaders(req: IncomingMessage, port: number, keepUpgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const drop = new Set([...HOP_BY_HOP, ...WEBTERM_HEADERS, 'host', 'cookie', 'origin'])
  for (const n of (firstHeader(req.headers.connection) ?? '').split(',')) drop.add(n.trim().toLowerCase())
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !drop.has(k)) out[k] = v
  out.host = `localhost:${port}` // vite et al. check Host (allowedHosts); localhost always passes
  // The browser Origin was already checked against webterm's own Host; upstream sees its own origin.
  if (req.headers.origin) out.origin = `http://localhost:${port}`
  const cookie = stripWebtermCookie(firstHeader(req.headers.cookie))
  if (cookie) out.cookie = cookie
  if (keepUpgrade) { out.connection = 'Upgrade'; out.upgrade = firstHeader(req.headers.upgrade) ?? 'websocket' }
  return out
}

function responseHeaders(raw: IncomingMessage['headers'], t: ProxyTarget): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const drop = new Set(HOP_BY_HOP)
  for (const n of (firstHeader(raw.connection) ?? '').split(',')) drop.add(n.trim().toLowerCase())
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && !drop.has(k)) out[k] = v
  const loc = firstHeader(raw.location)
  // Strip mode only: an upstream-absolute path must stay under the prefix (code-server proxy.ts does the same).
  if (t.kind === 'proxy' && loc?.startsWith('/') && !loc.startsWith('//')) out.location = t.prefix + loc
  return out
}

const cookieHeader = (token: string, prefix: string): string => `${PROXY_COOKIE}=${cookieValue(token)}; Path=${prefix}; HttpOnly; SameSite=Strict`

function deny(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(reason)
}

/** HTTP side. Returns false when the URL is not a proxy path (caller keeps routing). */
export function handleProxyRequest(req: IncomingMessage, res: ServerResponse, deps: ProxyDeps): boolean {
  const t = parseProxyUrl(req.url ?? '/')
  if (t === null) return false
  void serveHttp(req, res, t, deps).catch((err: unknown) => {
    log.error('proxy.http_failed', 'Proxy request failed', { cause: err instanceof Error ? err.message : String(err) })
    if (!res.headersSent) deny(res, 502, 'bad gateway')
    else res.destroy()
  })
  return true
}

async function serveHttp(req: IncomingMessage, res: ServerResponse, t: NonNullable<ReturnType<typeof parseProxyUrl>>, deps: ProxyDeps): Promise<void> {
  const token = deps.token()
  const g = gate(req, token, deps, false)
  if (!g.ok) return deny(res, 403, 'forbidden')
  if (t === 'bad_port') return deny(res, 400, 'invalid port')
  // `/proxy/5173` -> `/proxy/5173/` (code-server behaviour). Location is built from the parsed port only: no open redirect.
  if (t.bare) { res.writeHead(308, { Location: `${t.prefix}/${t.search}` }); res.end(); return }
  const target = await resolveTarget(t.port, deps)
  if (!target.ok) {
    log.warn('proxy.reject', `Proxy to port ${t.port} refused (${target.reason})`, { port: t.port, reason: target.reason })
    return deny(res, target.status, target.reason)
  }
  if (g.setCookie && token !== undefined) res.setHeader('Set-Cookie', cookieHeader(token, t.prefix))
  const up = httpRequest({ host: target.ip, port: t.port, method: req.method, path: t.path + t.search, headers: upstreamHeaders(req, t.port, false), timeout: CONNECT_TIMEOUT_MS }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, responseHeaders(ur.headers, t))
    ur.pipe(res)
  })
  up.on('timeout', () => up.destroy(new Error('upstream timeout')))
  up.on('error', (err) => {
    log.warn('proxy.upstream_error', `Upstream on port ${t.port} failed`, { port: t.port, cause: err.message })
    if (!res.headersSent) deny(res, 502, 'bad gateway')
    else res.destroy()
  })
  req.pipe(up)
}

function refuseSocket(socket: Duplex, status: string, reason: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`)
}

/** WebSocket side (HMR). Same gate, Origin required on a token-free bind (as /ws); then a raw TCP splice. */
export function handleProxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: ProxyDeps): boolean {
  const t = parseProxyUrl(req.url ?? '/')
  if (t === null) return false
  socket.on('error', () => socket.destroy()) // client gone: nothing to report
  void (async () => {
    const token = deps.token()
    if (!gate(req, token, deps, true).ok) return refuseSocket(socket, '403 Forbidden', 'forbidden')
    if (t === 'bad_port' || t.bare) return refuseSocket(socket, '400 Bad Request', 'invalid proxy path')
    const target = await resolveTarget(t.port, deps)
    if (!target.ok) return refuseSocket(socket, '403 Forbidden', target.reason)
    const upstream: Socket = connect({ host: target.ip, port: t.port })
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream connect timeout')))
    let established = false
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(0)
      const lines = [`${req.method ?? 'GET'} ${t.path}${t.search} HTTP/1.1`]
      for (const [k, v] of Object.entries(upstreamHeaders(req, t.port, true))) for (const one of [v].flat()) lines.push(`${k}: ${one}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', (err) => {
      log.warn('proxy.upstream_error', `Upstream WebSocket on port ${t.port} failed`, { port: t.port, cause: err.message })
      if (!established) refuseSocket(socket, '502 Bad Gateway', 'bad gateway')
      else socket.destroy()
    })
    upstream.on('close', () => { if (established) socket.destroy() })
    socket.on('close', () => upstream.destroy())
  })().catch((err: unknown) => {
    log.error('proxy.ws_failed', 'Proxy upgrade failed', { cause: err instanceof Error ? err.message : String(err) })
    socket.destroy()
  })
  return true
}
