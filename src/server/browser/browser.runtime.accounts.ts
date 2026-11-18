// Assembly of the profile account check for the browser runtime: the service, the Settings switch and the triggers
// (profile process comes alive, cookies imported, a tab reaches a provider host or leaves its login/logout pages).
// The popover trigger is the client asking the refresh route. There is no timer.
import { ACCOUNT_PROVIDERS, cookieDomainMatches } from '../../shared/browser.accounts'
import { BROWSER_PROFILES_EVENT } from '../../shared/browser.profile'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { BrowserProfilesMsg } from '../../shared/protocol'
import { flagOr } from '../envFlag'
import type { CookieInjector } from '../browserApi'
import { createAccountsService } from './browser.accounts.service'
import type { AccountsService } from './browser.accounts.service'
import { createAccountsStore } from './browser.accounts.store'
import type { CdpClient } from './cdp.client'
import type { BrowserLauncher } from './chromium.launch'
import type { GuardResult } from './navigation.guard'

/** Default ON (approved by the owner); only an explicit `off` turns the check and the display off. */
export const accountsOn = (env: Record<string, string | undefined>): boolean => flagOr(env[ENV_BROWSER.accounts], true)

/** Paths on a provider host where a session starts, ends or is managed. */
const SESSION_PATH = /login|logout|signin|sign-in|signout|sign_out|session|accounts?\b|servicelogin|oauth/i

const urlOf = (url: string): URL | null => {
  try { return new URL(url) } catch { return null }
}
const onProvider = (u: URL | null): u is URL =>
  u !== null && ACCOUNT_PROVIDERS.some((p) => p.cookieDomains.some((d) => cookieDomainMatches(u.hostname, d)))

/** A navigation worth a check: the new page is on a provider host. `sessionChange` = it came from, or is, a login/logout/account page there. */
export function navigationHit(prevUrl: string | undefined, url: string): { sessionChange: boolean } | null {
  const next = urlOf(url)
  if (!onProvider(next) || prevUrl === url) return null
  const prev = prevUrl ? urlOf(prevUrl) : null
  return { sessionChange: SESSION_PATH.test(next.pathname) || (onProvider(prev) && SESSION_PATH.test(prev.pathname)) }
}

export interface AccountsWiring {
  service: AccountsService
  /** Feed every host state update; `profileId` = the profile the node runs on. */
  onState(s: BrowserState, profileId: string | undefined): void
  /** Cookie import into a profile starts a check once the cookies are in. */
  wrapInjector(inj: CookieInjector): CookieInjector
  forgetNode(nodeId: string): void
}

export function createAccountsWiring(d: {
  env: Record<string, string | undefined>
  dataRoot: string
  launcher: BrowserLauncher
  connect?: (wsUrl: string) => Promise<CdpClient>
  guard(url: string): GuardResult
  broadcast?: (msg: BrowserProfilesMsg) => void
  now?: () => number
}): AccountsWiring {
  const service = createAccountsService({
    launcher: d.launcher, connect: d.connect, guard: d.guard, store: createAccountsStore(d.dataRoot), now: d.now,
    enabled: () => accountsOn(d.env), changed: () => d.broadcast?.({ t: BROWSER_PROFILES_EVENT }),
  })
  // `pending`: a provider page was reached while it was still loading; the check waits for the load to stop.
  const seen = new Map<string, { live: boolean; url: string; pending: { sessionChange: boolean } | null }>()
  return {
    service,
    onState(s, profileId) {
      const prev = seen.get(s.id)
      const pending = prev && prev.url === s.url ? prev.pending : navigationHit(prev?.url, s.url)
      const settled = !!profileId && s.live === 'live' && !s.loading
      seen.set(s.id, { live: s.live === 'live', url: s.url, pending: settled ? null : pending })
      if (!profileId || s.live !== 'live') return
      if (!prev?.live) { service.trigger(profileId, 'profile_live'); return }
      if (pending && settled) service.trigger(profileId, 'navigation', pending)
    },
    wrapInjector: (inj) => ({
      ...inj,
      async inject(profileId, cookies) {
        await inj.inject(profileId, cookies)
        service.trigger(profileId, 'cookies_imported')
      },
    }),
    forgetNode: (id) => { seen.delete(id) },
  }
}
