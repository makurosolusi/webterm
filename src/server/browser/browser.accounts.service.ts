// "Who is signed in" per browser profile (docs/decisions/browser-profile-accounts.md). Rules that keep it polite to the providers:
// no polling (callers trigger it), at most one check per profile at a time, a TTL per profile + provider, a 15 s floor even for the
// Refresh button, and exponential backoff after a challenge / rate-limit page (state `unknown`, no retry until the backoff ends).
// It never launches Chromium (a profile without a running process keeps its last answer), never logs more than
// provider + state + profile id, and a provider is asked only when the profile holds a cookie for the provider's domain.
import { ACCOUNT_BACKOFF_MAX_MS, ACCOUNT_CHECK_TTL_MS, ACCOUNT_FORCE_FLOOR_MS, ACCOUNT_PROVIDERS } from '../../shared/browser.accounts'
import type { AccountProvider, ProfileAccount } from '../../shared/browser.accounts'
import { CdpClient } from './cdp.client'
import type { BrowserLauncher } from './chromium.launch'
import type { GuardResult } from './navigation.guard'
import type { AccountsStore } from './browser.accounts.store'
import { cookieDomainsOf, isCandidate, probeProvider } from './browser.accounts.probe'
import type { ParsedAccount } from './browser.accounts.parsers'
import { createLogger } from '../logs'

const log = createLogger('browser.accounts')

/** Why a check was asked for (the four triggers; there is no timer). */
export type AccountTrigger = 'profile_live' | 'cookies_imported' | 'navigation' | 'popover'

export interface AccountsDeps {
  launcher: Pick<BrowserLauncher, 'acquire' | 'isLive'>
  connect?: (wsUrl: string) => Promise<CdpClient>
  guard(url: string): GuardResult
  store: AccountsStore
  /** The Settings switch; off = no check, no data. */
  enabled(): boolean
  /** Tell every window the profile list changed. */
  changed(): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface AccountsService {
  /** Last known accounts (memory, else disk); [] while the setting is off. */
  get(profileId: string): ProfileAccount[]
  /** Ask for a check; honours the TTL (a `sessionChange` honours only the floor). Never throws, never waits for the result. */
  trigger(profileId: string, why: AccountTrigger, opts?: { sessionChange?: boolean }): void
  /** The Refresh button: skips the TTL (unless `respectTtl`, used when a popover merely opens), still serial per profile and floored. Resolves with the accounts after the check. */
  refresh(profileId: string, opts?: { respectTtl?: boolean }): Promise<ProfileAccount[]>
  /** Forget a deleted profile (memory + file). */
  forget(profileId: string): void
}

const same = (a: ProfileAccount | undefined, b: ProfileAccount): boolean =>
  !!a && a.state === b.state && a.displayName === b.displayName && a.emailMasked === b.emailMasked && a.avatarUrl === b.avatarUrl

export function createAccountsService(d: AccountsDeps): AccountsService {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const connect = d.connect ?? ((u: string) => CdpClient.connect(u))
  const cache = new Map<string, ProfileAccount[]>()
  const inflight = new Map<string, Promise<void>>()
  const lastTry = new Map<string, number>()
  const backoff = new Map<string, { until: number; hits: number }>()

  const read = (id: string): ProfileAccount[] => {
    let v = cache.get(id)
    if (!v) cache.set(id, (v = d.store.load(id)))
    return v
  }
  const due = (key: string, spacing: number): boolean => {
    const t = now()
    const b = backoff.get(key)
    if (b && t < b.until) return false
    const last = lastTry.get(key)
    return last === undefined || t - last >= spacing
  }

  function record(id: string, p: AccountProvider, parsed: ParsedAccount, key: string): boolean {
    const at = now()
    let next: ProfileAccount
    if (parsed.challenge) {
      const hits = (backoff.get(key)?.hits ?? 0) + 1
      backoff.set(key, { hits, until: at + Math.min(ACCOUNT_CHECK_TTL_MS * 2 ** hits, ACCOUNT_BACKOFF_MAX_MS) })
      next = { provider: p.id, state: 'unknown', checkedAt: at }
    } else {
      backoff.delete(key)
      next = {
        provider: p.id, checkedAt: at, state: parsed.state,
        ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
        ...(parsed.emailMasked ? { emailMasked: parsed.emailMasked } : {}),
        ...(parsed.avatarUrl ? { avatarUrl: parsed.avatarUrl } : {}),
      }
    }
    const list = read(id)
    const prev = list.find((a) => a.provider === p.id)
    cache.set(id, [...list.filter((a) => a.provider !== p.id), next].sort((a, b) => a.provider.localeCompare(b.provider)))
    log.info('browser.accounts.checked', 'account check finished', { ids: { profileId: id }, provider: p.id, state: next.state })
    return !same(prev, next)
  }

  async function check(id: string, spacing: number): Promise<void> {
    let changed = false
    const cdp = await connect(await d.launcher.acquire(id)) // the process is live (checked by the caller): this never launches one
    try {
      const domains = await cookieDomainsOf(cdp)
      for (const p of ACCOUNT_PROVIDERS) {
        const key = `${id}:${p.id}`
        if (!isCandidate(domains, p)) {
          // No cookie for the provider: signed out without a single request.
          if (read(id).find((a) => a.provider === p.id)?.state !== 'signed_out') changed = record(id, p, { challenge: false, state: 'signed_out' }, key) || changed
          continue
        }
        if (!due(key, spacing)) continue
        lastTry.set(key, now())
        try {
          changed = record(id, p, await probeProvider(cdp, p, { guard: d.guard, sleep }), key) || changed
        } catch (e) {
          // One provider failing (tab crash, CDP timeout) must not hide the other; the old answer stays.
          log.warn('browser.accounts.probe', 'account check failed', { ids: { profileId: id }, provider: p.id, error: e instanceof Error ? e.name : typeof e })
        }
      }
    } finally {
      cdp.close()
    }
    d.store.save(id, read(id))
    if (changed) d.changed()
  }

  function run(id: string, spacing: number): Promise<void> {
    if (!d.enabled() || !d.launcher.isLive?.(id)) return Promise.resolve()
    const running = inflight.get(id)
    if (running) return running // serial per profile: join the check in flight
    const p = check(id, spacing)
      .catch((e: unknown) => log.warn('browser.accounts.check', 'account check could not run', { ids: { profileId: id }, error: e instanceof Error ? e.name : typeof e }))
      .finally(() => { inflight.delete(id) })
    inflight.set(id, p)
    return p
  }

  return {
    get: (id) => (d.enabled() ? read(id) : []),
    trigger(id, why, opts) {
      log.debug('browser.accounts.trigger', 'account check requested', { ids: { profileId: id }, reason: why })
      void run(id, opts?.sessionChange ? ACCOUNT_FORCE_FLOOR_MS : ACCOUNT_CHECK_TTL_MS)
    },
    async refresh(id, opts) { await run(id, opts?.respectTtl ? ACCOUNT_CHECK_TTL_MS : ACCOUNT_FORCE_FLOOR_MS); return d.enabled() ? read(id) : [] },
    forget(id) {
      cache.delete(id); inflight.delete(id); d.store.remove(id)
      for (const k of [...lastTry.keys(), ...backoff.keys()]) if (k.startsWith(`${id}:`)) { lastTry.delete(k); backoff.delete(k) }
    },
  }
}
