// Which icon URLs the server may fetch for a page. The page itself already passed the navigation guard, so its own
// origin is fine; a cross-origin icon goes through the same guard AND may not point a public page at a private address.
import { isIP } from 'node:net'
import { classifyIp } from './ssrf.ip'
import { isLocalName, normalizeHost } from './ssrf.allowlist'
import type { NavGuard } from './browserHost.targets'

const isPrivateHost = (host: string): boolean => {
  const h = normalizeHost(host)
  return isLocalName(h) || (isIP(h) !== 0 && classifyIp(h) === 'private')
}

function parse(u: string): URL | null {
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** True when the server may fetch `iconUrl` for the page at `pageUrl`. */
export function faviconAllowed(iconUrl: string, pageUrl: string, guard: NavGuard): boolean {
  const icon = parse(iconUrl)
  const page = parse(pageUrl)
  if (!icon || !page) return false
  if (icon.origin === page.origin) return true
  if (guard.check(icon.href) !== null) return false
  return !isPrivateHost(icon.hostname) || isPrivateHost(page.hostname)
}
