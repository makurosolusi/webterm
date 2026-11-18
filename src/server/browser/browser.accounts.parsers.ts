// One defensive parser per account provider. Input is what the page showed (`ProbeRaw`), output is a state plus public
// identity bits. These are UNOFFICIAL surfaces that can change: anything not recognised is `unknown` (never a guess, never a
// throw), and a human-check / rate-limit page is `challenge`, which makes the service back off instead of retrying.
import { ACCOUNT_PROVIDERS, cleanAccountName, maskEmail, safeAvatarUrl } from '../../shared/browser.accounts'
import type { AccountProviderId, AccountState } from '../../shared/browser.accounts'

/** What the extractor script read from the probe page (all bounded; never cookies or storage). */
export interface ProbeRaw {
  url: string
  title: string
  /** First characters of `body.innerText`. */
  text: string
  /** Content of `<meta name="user-login">`: null = tag absent, '' = present and empty. */
  userLogin: string | null
  /** `src` of the first avatar image, if any. */
  avatar: string | null
}

export type ParsedAccount = { challenge: false; state: AccountState; displayName?: string; emailMasked?: string; avatarUrl?: string } | { challenge: true }

/** Page script run in the probe tab; returns a JSON string of `ProbeRaw`. Reads text and two meta/img attributes only. */
export const EXTRACT_SCRIPT = `(() => {
  const meta = document.querySelector('meta[name="user-login"]');
  const img = document.querySelector('img.avatar-user, img.avatar');
  return JSON.stringify({
    url: location.href, title: document.title || '', text: (document.body ? document.body.innerText : '').slice(0, 6000),
    userLogin: meta ? (meta.getAttribute('content') || '') : null, avatar: img ? img.src : null,
  });
})()`

const CHALLENGE = /captcha|unusual traffic|are you a robot|verify you are (a )?human|too many requests|rate limit|\/sorry\//i
const unknown: ParsedAccount = { challenge: false, state: 'unknown' }
const isChallenge = (raw: ProbeRaw): boolean => CHALLENGE.test(`${raw.url}\n${raw.title}\n${raw.text.slice(0, 300)}`)

// Chromium's ListAccounts: ["gaia.l.a.r",[["gaia.l.a",1,"Name","email","avatar",...,validFlag(9),gaiaId(10),...,signedOut(14)]]].
// Indexes follow Chromium's gaia_auth_util.cc (email 3, valid 9, signed-out 14); name (2) and avatar (4) are best effort.
const G_NAME = 2, G_EMAIL = 3, G_AVATAR = 4, G_VALID = 9, G_SIGNED_OUT = 14
const GOOGLE_HOST = 'accounts.google.com'

function parseGoogle(raw: ProbeRaw): ParsedAccount {
  if (isChallenge(raw)) return { challenge: true }
  let host = ''
  try { host = new URL(raw.url).hostname } catch { return unknown }
  if (host !== GOOGLE_HOST || !raw.url.includes('/ListAccounts')) return unknown // redirected to a sign-in or consent page
  let data: unknown
  try { data = JSON.parse(raw.text.trim().replace(/^\)\]\}'/, '')) } catch { return unknown }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return unknown
  const rows = (data[1] as unknown[]).filter((r): r is unknown[] => Array.isArray(r) && typeof r[G_EMAIL] === 'string' && r[G_EMAIL] !== '')
  if (rows.length === 0) return { challenge: false, state: 'signed_out' }
  const live = rows.filter((r) => r[G_SIGNED_OUT] !== 1)
  if (live.length === 0) return { challenge: false, state: 'signed_out' }
  const valid = live.find((r) => r[G_VALID] !== 0)
  const row = valid ?? live[0] // the first listed account is the browser's default one
  const avatarUrl = safeAvatarUrl(row[G_AVATAR], ACCOUNT_PROVIDERS[0].avatarHosts)
  return {
    challenge: false, state: valid ? 'signed_in' : 'expired',
    displayName: cleanAccountName(row[G_NAME]), emailMasked: maskEmail(row[G_EMAIL]), ...(avatarUrl ? { avatarUrl } : {}),
  }
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

function parseGithub(raw: ProbeRaw): ParsedAccount {
  if (isChallenge(raw)) return { challenge: true }
  let host = ''
  try { host = new URL(raw.url).hostname } catch { return unknown }
  if (host !== 'github.com' || raw.userLogin === null) return unknown // meta tag gone = the markup changed: do not guess
  if (raw.userLogin === '') return { challenge: false, state: 'signed_out' }
  if (!GITHUB_LOGIN.test(raw.userLogin)) return unknown
  const avatarUrl = raw.avatar ? safeAvatarUrl(raw.avatar, ACCOUNT_PROVIDERS[1].avatarHosts) : undefined
  return { challenge: false, state: 'signed_in', displayName: raw.userLogin, ...(avatarUrl ? { avatarUrl } : {}) }
}

/** Provider id -> parser. A new provider = a row in ACCOUNT_PROVIDERS plus one entry here. */
export const ACCOUNT_PARSERS: Record<AccountProviderId, (raw: ProbeRaw) => ParsedAccount> = { google: parseGoogle, github: parseGithub }

/** Parse the page-script output (untrusted string); anything malformed is `unknown`. */
export function parseProbe(provider: AccountProviderId, json: unknown): ParsedAccount {
  let raw: unknown
  try { raw = typeof json === 'string' ? JSON.parse(json) : null } catch { return unknown }
  if (typeof raw !== 'object' || raw === null) return unknown
  const r = raw as Record<string, unknown>
  if (typeof r.url !== 'string') return unknown
  return ACCOUNT_PARSERS[provider]({
    url: r.url, title: typeof r.title === 'string' ? r.title : '', text: typeof r.text === 'string' ? r.text : '',
    userLogin: typeof r.userLogin === 'string' ? r.userLogin : null, avatar: typeof r.avatar === 'string' ? r.avatar : null,
  })
}
