// Link previews (Open Graph / Twitter cards) need ABSOLUTE image URLs, but the host differs per
// install (127.0.0.1, a LAN IP, a tunnel). index.html therefore carries a placeholder origin that
// is swapped for the requesting origin when the page is served. `.invalid` (RFC 2606) can never
// resolve, so a page served without the rewrite (dev) points nowhere rather than at a wrong host.
import type { IncomingHttpHeaders } from 'node:http'

/** Placeholder origin written in `src/client/index.html` for every absolute share URL. */
export const ORIGIN_PLACEHOLDER = 'https://webterm.invalid'

/** A plain `Host` value (name / IPv4 / [IPv6], optional port): nothing that could break out of an HTML attribute. */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/**
 * The origin the client used, or null when `Host` is missing or not a plain host. The scheme
 * follows `X-Forwarded-Proto: https` like the session cookie's `Secure` flag (routes/auth.routes.ts
 * `sessionCookie`): a spoofed header only changes the spoofer's own response.
 */
export function requestOrigin(headers: IncomingHttpHeaders, encrypted = false): string | null {
  const host = first(headers.host)
  if (!host || !SAFE_HOST.test(host)) return null
  const proto = first(headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase()
  return `${proto === 'https' || (proto === undefined && encrypted) ? 'https' : 'http'}://${host}`
}

/** `html` with the placeholder replaced by `origin`; null origin leaves root-relative URLs. */
export function withRequestOrigin(html: string, origin: string | null): string {
  return html.split(ORIGIN_PLACEHOLDER).join(origin ?? '')
}
