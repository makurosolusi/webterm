// Pure header handling of the credential proxy: allowlist inbound, inject the real credential, filter outbound.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Upstream } from './credentialProxy.types'

const ALLOW_EXACT = new Set(['content-type', 'accept', 'accept-language', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access', 'user-agent', 'x-app', 'idempotency-key', 'x-request-id'])
const ALLOW_PREFIX = ['x-stainless-', 'x-claude-code-']
// Response headers that describe the transfer, not the content: Bun decodes the body, so these would lie.
const DROP_RESPONSE = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'set-cookie', 'set-cookie2'])
// Custom upstream headers may not override the credential/transport headers the proxy owns.
const RESERVED_CUSTOM = new Set(['x-api-key', 'authorization', 'host', 'content-length', 'cookie'])

/** The credential a client presented: `x-api-key`, else `Authorization: Bearer`. */
export function presentedToken(h: Headers): string | null {
  const key = h.get('x-api-key')
  if (key) return key
  const m = /^Bearer\s+(.+)$/i.exec(h.get('authorization') ?? '')
  return m ? m[1]!.trim() : null
}

/** Constant-time string compare (hashes first so length differences leak nothing). */
export function tokensEqual(a: string | null, b: string): boolean {
  if (a === null) return false
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** Upstream request headers: allowlisted client headers, configured custom headers, then the real credential. */
export function buildUpstreamHeaders(incoming: Headers, up: Upstream): Headers {
  const out = new Headers()
  incoming.forEach((value, name) => {
    const n = name.toLowerCase()
    if (ALLOW_EXACT.has(n) || ALLOW_PREFIX.some((p) => n.startsWith(p))) out.set(n, value)
  })
  for (const [name, value] of Object.entries(up.headers)) {
    const n = name.toLowerCase()
    if (!RESERVED_CUSTOM.has(n) && !n.startsWith('proxy-')) out.set(n, value)
  }
  if (up.kind === 'bearer') out.set('authorization', `Bearer ${up.secret}`)
  else out.set('x-api-key', up.secret)
  return out
}

/** Response headers safe to hand back to the client. */
export function filterResponseHeaders(h: Headers): Headers {
  const out = new Headers()
  h.forEach((value, name) => { if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value) })
  return out
}
