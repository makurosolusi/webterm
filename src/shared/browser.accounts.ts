// "Signed in as ..." for a browser profile: the pure model shared by server, client and agent tools.
// Providers are DATA (a row in ACCOUNT_PROVIDERS plus one parser on the server): adding a provider is a new row and a parser,
// nothing else. Only Google and GitHub exist. Never carries a cookie, a token or a full email address.

export const ACCOUNT_PROVIDER_IDS = ['google', 'github'] as const
export type AccountProviderId = (typeof ACCOUNT_PROVIDER_IDS)[number]
export const ACCOUNT_STATES = ['signed_in', 'signed_out', 'expired', 'unknown'] as const
export type AccountState = (typeof ACCOUNT_STATES)[number]

/** Do not re-check the same profile + provider more often than this (also the base of the backoff after a challenge). */
export const ACCOUNT_CHECK_TTL_MS = 10 * 60_000
/** A user pressing Refresh skips the TTL but never goes below this spacing per profile + provider. */
export const ACCOUNT_FORCE_FLOOR_MS = 15_000
/** Backoff after a 429/challenge page doubles per consecutive hit up to this cap. */
export const ACCOUNT_BACKOFF_MAX_MS = 6 * 3_600_000
export const ACCOUNT_NAME_MAX = 80
export const accountsRefreshPath = (profileId: string): string => `/api/browser/profiles/${encodeURIComponent(profileId)}/accounts/refresh`

export interface ProfileAccount {
  provider: AccountProviderId
  state: AccountState
  displayName?: string
  /** First letter of the local part + the domain (`b***@gmail.com`); the full address is never stored. */
  emailMasked?: string
  /** https image on one of the provider's own hosts; optional. */
  avatarUrl?: string
  checkedAt: number
}

export interface AccountProvider {
  id: AccountProviderId
  label: string
  /** A cookie on one of these domains (or a subdomain) marks the profile as a candidate; without one nothing is requested. */
  cookieDomains: readonly string[]
  /** The single page the check loads inside the profile's own Chromium (public provider URL, passes the navigation guard). */
  probeUrl: string
  /** Hosts an avatar may come from. */
  avatarHosts: readonly string[]
}

export const ACCOUNT_PROVIDERS: readonly AccountProvider[] = [
  {
    id: 'google', label: 'Google', cookieDomains: ['google.com'],
    // Chromium's own signed-in-accounts listing (gaia ListAccounts): name + email, no full page load. Unofficial; see docs/decisions/browser-profile-accounts.md.
    probeUrl: 'https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser&gpsia=1',
    avatarHosts: ['googleusercontent.com'],
  },
  { id: 'github', label: 'GitHub', cookieDomains: ['github.com'], probeUrl: 'https://github.com/', avatarHosts: ['avatars.githubusercontent.com', 'github.com'] },
]

export const providerOf = (id: string): AccountProvider | undefined => ACCOUNT_PROVIDERS.find((p) => p.id === id)

/** `bip@gmail.com` -> `b***@gmail.com`; anything that is not an address gives undefined. */
export function maskEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(raw.trim())
  if (!m) return undefined
  const first = [...m[1]][0]
  return `${first}***@${m[2].toLowerCase()}`
}

/** `https://host/...` whose host is (a subdomain of) one of `hosts`; otherwise undefined. */
export function safeAvatarUrl(raw: unknown, hosts: readonly string[]): string | undefined {
  if (typeof raw !== 'string' || raw.length > 600) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password) return undefined
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? u.toString() : undefined
  } catch {
    return undefined // not a URL: no avatar, the row still shows
  }
}

/** True when a cookie domain (`.accounts.google.com`) belongs to `suffix` (`google.com`). */
export const cookieDomainMatches = (cookieDomain: string, suffix: string): boolean => {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  return d === suffix || d.endsWith(`.${suffix}`)
}

/** A display name for a tooltip: control characters removed, trimmed, capped; undefined when empty. */
export const cleanAccountName = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex -- a display name is shown in a tooltip: no control characters
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return s === '' ? undefined : s.slice(0, ACCOUNT_NAME_MAX)
}

/** Validate one stored/received account (untrusted JSON): rebuilds it field by field; undefined = drop. */
export function validateAccount(raw: unknown): ProfileAccount | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const p = providerOf(String(r.provider))
  if (!p || !ACCOUNT_STATES.includes(r.state as AccountState) || typeof r.checkedAt !== 'number' || !Number.isFinite(r.checkedAt)) return undefined
  const displayName = cleanAccountName(r.displayName)
  // Re-mask: a stored value that is a full address (a bug or a hand edit) is masked again, never passed through.
  const emailMasked = typeof r.emailMasked === 'string' && /^[^\s@]\*\*\*@[^\s@]+$/.test(r.emailMasked) ? r.emailMasked : maskEmail(r.emailMasked)
  const avatarUrl = safeAvatarUrl(r.avatarUrl, p.avatarHosts)
  return {
    provider: p.id, state: r.state as AccountState, checkedAt: r.checkedAt,
    ...(displayName ? { displayName } : {}), ...(emailMasked ? { emailMasked } : {}), ...(avatarUrl ? { avatarUrl } : {}),
  }
}

export const validateAccounts = (raw: unknown): ProfileAccount[] =>
  Array.isArray(raw) ? raw.map(validateAccount).filter((a): a is ProfileAccount => a !== undefined) : []

/** Accounts that count as "somebody is signed in" (a dot on the chip). */
export const signedInAccounts = (a: readonly ProfileAccount[] | undefined): ProfileAccount[] => (a ?? []).filter((x) => x.state === 'signed_in')

/** One short text per account for agent output: "Google: Bip (b***@gmail.com)" or "Google: signed out". */
export function describeAccount(a: ProfileAccount): string {
  const who = [a.displayName, a.emailMasked ? `(${a.emailMasked})` : ''].filter(Boolean).join(' ')
  const label = providerOf(a.provider)?.label ?? a.provider
  return a.state === 'signed_in' ? `${label}: ${who || 'signed in'}` : `${label}: ${a.state.replace('_', ' ')}`
}
