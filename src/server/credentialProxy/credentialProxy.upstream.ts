// Request target validation and upstream URL building (origin lock) for the credential proxy.
import type { ProxyErrorCode, Upstream } from './credentialProxy.types'

const PATH_SHAPE = /^\/v1\/[A-Za-z0-9\-._~!$&'()*+,;=:%/]*$/

/** The path+query of a request URL exactly as sent (no WHATWG dot-segment folding). */
export function rawTarget(reqUrl: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(reqUrl)
  return m ? m[1]! : reqUrl
}

/** True when the path is a plain `/v1/...` path with no traversal, doubled slash, backslash, `@` or encoded separators. */
export function isAllowedPath(target: string): boolean {
  const path = target.split('?')[0]!
  if (!PATH_SHAPE.test(path)) return false
  if (path.includes('//') || path.split('/').some((s) => s === '.' || s === '..')) return false
  return !/%(2e|2f|5c|00)/i.test(path)
}

export type Target = { ok: true; url: URL; upstream: Upstream } | { ok: false; code: ProxyErrorCode; status: number }

/** Map a client request target to the one upstream URL it may reach; the origin must equal the configured one. */
export function resolveTarget(resolveUpstream: () => Upstream | null, target: string): Target {
  if (!isAllowedPath(target)) return { ok: false, code: 'bad_request', status: 400 }
  const upstream = resolveUpstream()
  if (!upstream) return { ok: false, code: 'no_upstream', status: 503 }
  let base: URL
  try { base = new URL(upstream.baseUrl) } catch { return { ok: false, code: 'no_upstream', status: 503 } }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return { ok: false, code: 'no_upstream', status: 503 }
  const url = new URL(base.pathname.replace(/\/+$/, '') + target, base.origin)
  if (url.origin !== base.origin) return { ok: false, code: 'bad_request', status: 400 }
  return { ok: true, url, upstream }
}
