// Requests Shields never touches. A real Chrome sends Google's own first-party beacons (gen_204, client_204, /log) and
// loads human-verification widgets; EasyPrivacy-style lists block both, which makes the client look unlike Chrome and
// can leave a challenge page unsolvable. Measured: the engine blocks `www.google.com/gen_204`, `/client_204` and `/log`
// on a google.com page (docs/decisions/browser-fingerprint.md, row S1).
import { hostOnly } from '../../shared/browser.url'

const inDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)
/** google.com, google.co.id, google.de ... (www. and other subdomains included). */
const GOOGLE_HOST = /(^|\.)google\.(com|co\.[a-z]{2,3}|[a-z]{2,3})$/
const GOOGLE_STATIC = ['gstatic.com', 'googleapis.com']
/** Hosts that exist only to ask a visitor to prove they are human; blocking them breaks the check. */
const VERIFICATION_HOSTS = ['recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com']
const RECAPTCHA_PATH = /^\/recaptcha\//

/** True when Shields must let this request through: verification providers, and Google's own traffic on a Google page. */
export function shieldExempt(url: string, pageUrl: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  const host = u.hostname.toLowerCase()
  if (VERIFICATION_HOSTS.some((d) => inDomain(host, d))) return true
  if (RECAPTCHA_PATH.test(u.pathname) && (GOOGLE_HOST.test(host) || inDomain(host, 'gstatic.com'))) return true
  const page = hostOnly(pageUrl).toLowerCase()
  return GOOGLE_HOST.test(page) && (GOOGLE_HOST.test(host) || GOOGLE_STATIC.some((d) => inDomain(host, d)))
}
