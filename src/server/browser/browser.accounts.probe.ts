// The CDP part of an account check, run INSIDE the profile's own Chromium (so its cookies go only to the provider's own
// domain, through the same SSRF proxy as every page): list the cookie DOMAINS (values are never read), and load one provider
// page in a throw-away background tab to read the signed-in identity from it. No separate HTTP client ever sees a cookie.
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { cookieDomainMatches } from '../../shared/browser.accounts'
import type { AccountProvider } from '../../shared/browser.accounts'
import { EXTRACT_SCRIPT, parseProbe, unknownBecause } from './browser.accounts.parsers'
import type { ParsedAccount } from './browser.accounts.parsers'
import type { GuardResult } from './navigation.guard'
import { createLogger } from '../logs'

const log = createLogger('browser.accounts')
const LOAD_POLL_MS = 250
const LOAD_TIMEOUT_MS = 12_000
const BLANK = 'about:blank'

export interface ProbeDeps {
  guard(url: string): GuardResult
  sleep(ms: number): Promise<void>
}

/** One cookie as far as the check cares: where it lives and what it is called. The value is dropped the moment it is read. */
export interface CookieRef { domain: string; name: string }

/** The profile's cookies as domain + name pairs (values never leave this function). */
export async function cookieRefsOf(cdp: CdpClient): Promise<CookieRef[]> {
  const r = await cdp.send<{ cookies?: Array<{ domain?: unknown; name?: unknown }> }>('Storage.getCookies', {})
  return (r.cookies ?? []).flatMap((c) => (typeof c.domain === 'string' && typeof c.name === 'string' && c.domain ? [{ domain: c.domain, name: c.name }] : []))
}

/**
 * The network-free signal: does the profile hold a session cookie for the provider? A provider with named session cookies
 * needs one of them on its domain; a provider without names (GitHub) is a candidate on any cookie of its domain, as before.
 */
export function hasSession(cookies: readonly CookieRef[], p: AccountProvider): boolean {
  const onDomain = cookies.filter((c) => p.cookieDomains.some((s) => cookieDomainMatches(c.domain, s)))
  return p.sessionCookies ? onDomain.some((c) => p.sessionCookies?.includes(c.name)) : onDomain.length > 0
}

/** Load the provider's probe page in a hidden tab, read it, close the tab. Never throws for a page problem: that is `unknown`. */
export async function probeProvider(cdp: CdpClient, p: AccountProvider, d: ProbeDeps): Promise<ParsedAccount> {
  if (!d.guard(p.probeUrl).ok) return unknownBecause('probe_blocked')
  const { targetId } = await cdp.send<{ targetId: string }>(CDP.createTarget, { url: BLANK, background: true })
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
    const nav = await cdp.send<{ errorText?: string; isDownload?: boolean }>(CDP.navigate, { url: p.probeUrl }, sessionId)
    // Downloads are allowed in this browser (browser.downloads): a response served as a file never renders, so say so.
    if (nav.isDownload) return unknownBecause('probe_download')
    if (nav.errorText) return unknownBecause('probe_failed')
    const ready = `location.href !== ${JSON.stringify(BLANK)} && document.readyState === 'complete'`
    for (let waited = 0; ; waited += LOAD_POLL_MS) {
      const r = await cdp.send<{ result?: { value?: unknown } }>(CDP.evaluate, { expression: ready, returnByValue: true }, sessionId)
      if (r.result?.value === true) break
      if (waited >= LOAD_TIMEOUT_MS) return unknownBecause('probe_timeout')
      await d.sleep(LOAD_POLL_MS)
    }
    const out = await cdp.send<{ result?: { value?: unknown } }>(CDP.evaluate, { expression: EXTRACT_SCRIPT, returnByValue: true }, sessionId)
    return parseProbe(p.id, out.result?.value)
  } finally {
    await cdp.send(CDP.closeTarget, { targetId }).catch((e: unknown) =>
      log.warn('browser.accounts.probe', 'probe tab was not closed', { provider: p.id, error: e instanceof Error ? e.name : typeof e }))
  }
}
