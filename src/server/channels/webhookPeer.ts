// Peer identity for webhook auth-failure throttling (P5 residual). Behind a reverse proxy every
// request shares the proxy socket address, so keying the throttle on it lets 30 bad secrets from
// anywhere block legitimate deliveries for the whole window. `x-forwarded-for` fixes that, but the
// header is client-controlled: it is only honored when the operator explicitly opts in, and only
// its first entry is trusted because every element after it is appended by a hop we do not control.
import { flagOn } from '../envFlag'
import { isIP } from 'node:net'
import { firstHeader } from '../httpHeaders'

/** Opt-in flag; anything but the literal `on` keeps the socket address authoritative. */
export const TRUST_PROXY_ENV = 'WEBTERM_TRUST_PROXY'
/** No peer information at all; still a single shared bucket, never an error. */
export const UNKNOWN_PEER = 'unknown'

export interface WebhookPeerRequest {
  socket?: { remoteAddress?: string } | null
  headers: Record<string, string | string[] | undefined>
}

/** True only for the explicit opt-in value, so a typo leaves the untrusted path unchanged. */
export function trustProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[TRUST_PROXY_ENV])
}

/**
 * First entry of `x-forwarded-for`, trimmed. Repeated headers arrive as an array; the first one
 * is the closest to the client and the first comma-separated hop inside it is the client address
 * the trusted proxy prepended. Returns null when there is no usable entry.
 */
function firstForwardedAddress(raw: string | string[] | undefined): string | null {
  const text = firstHeader(raw)
  if (typeof text !== 'string') return null
  const first = text.split(',')[0]?.trim() ?? ''
  return first === '' ? null : first
}

/**
 * Throttle bucket key for one request. Default is the socket address. With
 * `WEBTERM_TRUST_PROXY=on`, a syntactically valid IPv4/IPv6 first `x-forwarded-for` entry wins;
 * anything empty or invalid falls back to the socket address, so a malformed header can neither
 * invent a bucket nor escape the real one.
 */
export function webhookPeerKey(
  req: WebhookPeerRequest,
  env: NodeJS.ProcessEnv = process.env
): string {
  const socketAddress = req.socket?.remoteAddress ?? ''
  const fallback = socketAddress === '' ? UNKNOWN_PEER : socketAddress
  if (!trustProxyEnabled(env)) return fallback
  const candidate = firstForwardedAddress(req.headers['x-forwarded-for'])
  if (candidate === null || isIP(candidate) === 0) return fallback
  return candidate
}
