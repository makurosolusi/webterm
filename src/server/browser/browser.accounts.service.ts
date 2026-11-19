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
import { cookieRefsOf, hasSession, probeProvider } from './browser.accounts.probe'
import type { CookieRef } from './browser.accounts.probe'
import { unknownBecause } from './browser.accounts.parsers'
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
  /** The Settings switch (the list tells clients so they can hide the whole feature). */
  enabled(): boolean
  /** Last known accounts (memory, else disk); [] while the setting is off. */
  get(profileId: string): ProfileAccount[]
  /** Ask for a check; honours the TTL (a `sessionChange` honours only the floor). Never throws, never waits for the result. */
  trigger(profileId: string, why: AccountTrigger, opts?: { sessionChange?: boolean }): void
  /** The Refresh button: skips the TTL AND any automatic backoff (unless `respectTtl`, used when a popover merely opens), still serial per profile and floored. Resolves with the accounts after the check. */
  refresh(profileId: string, opts?: { respectTtl?: boolean }): Promise<ProfileAccount[]>
  /** Forget a deleted profile (memory + file). */
  forget(profileId: string): void
}

const same = (a: ProfileAccount | undefined, b: ProfileAccount): boolean =>
  !!a && a.state === b.state && a.reason === b.reason && a.displayName === b.displayName && a.emailMasked === b.emailMasked && a.avatarUrl === b.avatarUrl

export function createAccountsService(d: AccountsDeps): AccountsService {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const connect = d.connect ?? ((u: string) => CdpClient.connect(u))
  const cache = new Map<string, ProfileAccount[]>()
  const inflight = new Map<string, Promise<void>>()
  const lastTry = new Map<string, number>()
  const backoff = new Map<string, { until: number; hits: number }>()
  const signal = new Map<string, boolean>() // last seen "a session cookie exists" per profile + provider (memory only)

  const read = (id: string): ProfileAccount[] => {
    let v = cache.get(id)
    if (!v) cache.set(id, (v = d.store.load(id)))
    return v
  }
  const due = (key: string, spacing: number, manual: boolean): boolean => {
    const t = now()
    const b = backoff.get(key)
    if (!manual && b && t < b.until) return false // a human pressing Refresh is not held back by the automatic backoff
    const last = lastTry.get(key)
    return last === undefined || t - last >= spacing
  }

  type Answer = Omit<ProfileAccount, 'provider' | 'checkedAt'>
  function put(id: string, p: AccountProvider, answer: Answer): boolean {
    const next: ProfileAccount = { provider: p.id, checkedAt: now(), ...answer }
    const list = read(id)
    const prev = list.find((a) => a.provider === p.id)
    cache.set(id, [...list.filter((a) => a.provider !== p.id), next].sort((a, b) => a.provider.localeCompare(b.provider)))
    log.info('browser.accounts.checked', 'account check finished', { ids: { profileId: id }, provider: p.id, state: next.state, ...(next.reason ? { reason: next.reason } : {}) })
    return !same(prev, next)
  }

  /** Probe answer -> stored answer. A provider with named session cookies (Google) whose identity could not be read stays `signed_in` (no name): the cookie says a session exists. */
  function resolve(id: string, p: AccountProvider, parsed: ParsedAccount, key: string): Answer {
    const fallback = !!p.sessionCookies
    const prev = read(id).find((a) => a.provider === p.id)
    if (parsed.challenge || parsed.state === 'unknown') {
      const reason = parsed.challenge ? 'challenge' as const : parsed.reason ?? 'parse_failed' as const
      if (parsed.challenge) {
        const hits = (backoff.get(key)?.hits ?? 0) + 1
        backoff.set(key, { hits, until: now() + Math.min(ACCOUNT_CHECK_TTL_MS * 2 ** hits, ACCOUNT_BACKOFF_MAX_MS) })
      }
      if (!fallback) return { state: 'unknown', reason }
      const keep = prev?.state === 'signed_in' ? prev : undefined // the name read earlier stays valid while the session cookie does
      return { state: 'signed_in', reason, ...(keep?.displayName ? { displayName: keep.displayName } : {}), ...(keep?.emailMasked ? { emailMasked: keep.emailMasked } : {}), ...(keep?.avatarUrl ? { avatarUrl: keep.avatarUrl } : {}) }
    }
    backoff.delete(key)
    return {
      state: parsed.state,
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
      ...(parsed.emailMasked ? { emailMasked: parsed.emailMasked } : {}),
      ...(parsed.avatarUrl ? { avatarUrl: parsed.avatarUrl } : {}),
    }
  }

  async function checkProvider(id: string, p: AccountProvider, cdp: CdpClient, cookies: CookieRef[], spacing: number, manual: boolean): Promise<boolean> {
    const key = `${id}:${p.id}`
    const prev = read(id).find((a) => a.provider === p.id)
    const session = hasSession(cookies, p)
    const hadSession = signal.get(key)
    signal.set(key, session)
    // No session cookie: signed out without a single request.
    if (!session) return prev?.state === 'signed_out' ? false : put(id, p, { state: 'signed_out' })
    // A session cookie that was not there before = a login just happened: the automatic backoff of the old answer no longer applies.
    if (hadSession === false || (hadSession === undefined && prev?.state === 'signed_out')) backoff.delete(key)
    const baseline = (): boolean => (p.sessionCookies && prev?.state !== 'signed_in' ? put(id, p, { state: 'signed_in', reason: 'identity_unavailable' }) : false)
    if (!due(key, spacing, manual)) return baseline()
    lastTry.set(key, now())
    try {
      return put(id, p, resolve(id, p, await probeProvider(cdp, p, { guard: d.guard, sleep }), key))
    } catch (e) {
      // One provider failing (tab crash, CDP timeout) must not hide the other; identity is lost, the session signal is not.
      log.warn('browser.accounts.probe', 'account check failed', { ids: { profileId: id }, provider: p.id, error: e instanceof Error ? e.name : typeof e })
      return p.sessionCookies ? put(id, p, resolve(id, p, unknownBecause('probe_failed'), key)) : false
    }
  }

  async function check(id: string, spacing: number, manual: boolean): Promise<void> {
    let changed = false
    const cdp = await connect(await d.launcher.acquire(id)) // the process is live (checked by the caller): this never launches one
    try {
      let cookies: CookieRef[] | null = null
      try { cookies = await cookieRefsOf(cdp) } catch (e) {
        log.warn('browser.accounts.cookies', 'profile cookies could not be listed', { ids: { profileId: id }, error: e instanceof Error ? e.name : typeof e })
      }
      for (const p of ACCOUNT_PROVIDERS) {
        changed = (cookies ? await checkProvider(id, p, cdp, cookies, spacing, manual) : put(id, p, { state: 'unknown', reason: 'cookies_unreadable' })) || changed
      }
    } finally {
      cdp.close()
    }
    d.store.save(id, read(id))
    if (changed) d.changed()
  }

  function run(id: string, spacing: number, manual = false): Promise<void> {
    if (!d.enabled() || !d.launcher.isLive?.(id)) return Promise.resolve()
    const running = inflight.get(id)
    if (running) return running // serial per profile: join the check in flight
    const p = check(id, spacing, manual)
      .catch((e: unknown) => log.warn('browser.accounts.check', 'account check could not run', { ids: { profileId: id }, error: e instanceof Error ? e.name : typeof e }))
      .finally(() => { inflight.delete(id) })
    inflight.set(id, p)
    return p
  }

  return {
    enabled: () => d.enabled(),
    get: (id) => (d.enabled() ? read(id) : []),
    trigger(id, why, opts) {
      log.debug('browser.accounts.trigger', 'account check requested', { ids: { profileId: id }, reason: why })
      void run(id, opts?.sessionChange ? ACCOUNT_FORCE_FLOOR_MS : ACCOUNT_CHECK_TTL_MS)
    },
    async refresh(id, opts) { await run(id, opts?.respectTtl ? ACCOUNT_CHECK_TTL_MS : ACCOUNT_FORCE_FLOOR_MS, !opts?.respectTtl); return d.enabled() ? read(id) : [] },
    forget(id) {
      cache.delete(id); inflight.delete(id); d.store.remove(id)
      for (const k of [...lastTry.keys(), ...backoff.keys(), ...signal.keys()]) if (k.startsWith(`${id}:`)) { lastTry.delete(k); backoff.delete(k); signal.delete(k) }
    },
  }
}
