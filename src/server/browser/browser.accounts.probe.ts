// The CDP part of an account check, run INSIDE the profile's own Chromium (so its cookies go only to the provider's own
// domain, through the same SSRF proxy as every page): list the cookie DOMAINS (values are never read), and load one provider
// page in a throw-away background tab to read the signed-in identity from it. No separate HTTP client ever sees a cookie.
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { cookieDomainMatches } from '../../shared/browser.accounts'
import type { AccountProvider } from '../../shared/browser.accounts'
import { EXTRACT_SCRIPT, parseProbe } from './browser.accounts.parsers'
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

/** Domains of the cookies in the profile (the `domain` field only; names and values are dropped immediately). */
export async function cookieDomainsOf(cdp: CdpClient): Promise<string[]> {
  const r = await cdp.send<{ cookies?: Array<{ domain?: unknown }> }>('Storage.getCookies', {})
  return [...new Set((r.cookies ?? []).map((c) => (typeof c.domain === 'string' ? c.domain : '')).filter(Boolean))]
}

/** A cookie on one of the provider's domains is the only thing that makes the profile worth a request. */
export const isCandidate = (domains: readonly string[], p: AccountProvider): boolean =>
  domains.some((d) => p.cookieDomains.some((s) => cookieDomainMatches(d, s)))

const UNKNOWN: ParsedAccount = { challenge: false, state: 'unknown' }

/** Load the provider's probe page in a hidden tab, read it, close the tab. Never throws for a page problem: that is `unknown`. */
export async function probeProvider(cdp: CdpClient, p: AccountProvider, d: ProbeDeps): Promise<ParsedAccount> {
  if (!d.guard(p.probeUrl).ok) return UNKNOWN
  const { targetId } = await cdp.send<{ targetId: string }>(CDP.createTarget, { url: BLANK, background: true })
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
    const nav = await cdp.send<{ errorText?: string }>(CDP.navigate, { url: p.probeUrl }, sessionId)
    if (nav.errorText) return UNKNOWN
    const ready = `location.href !== ${JSON.stringify(BLANK)} && document.readyState === 'complete'`
    for (let waited = 0; ; waited += LOAD_POLL_MS) {
      const r = await cdp.send<{ result?: { value?: unknown } }>(CDP.evaluate, { expression: ready, returnByValue: true }, sessionId)
      if (r.result?.value === true) break
      if (waited >= LOAD_TIMEOUT_MS) return UNKNOWN
      await d.sleep(LOAD_POLL_MS)
    }
    const out = await cdp.send<{ result?: { value?: unknown } }>(CDP.evaluate, { expression: EXTRACT_SCRIPT, returnByValue: true }, sessionId)
    return parseProbe(p.id, out.result?.value)
  } finally {
    await cdp.send(CDP.closeTarget, { targetId }).catch((e: unknown) =>
      log.warn('browser.accounts.probe', 'probe tab was not closed', { provider: p.id, error: e instanceof Error ? e.name : typeof e }))
  }
}
