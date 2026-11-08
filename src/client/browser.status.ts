// Teks status overlay node browser. Murni; hanya hostname yang pernah ditampilkan (tanpa URL berquery).
import type { BlockReason, BrowserErrorCode, BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'

export interface BrowserErr { code: BrowserErrorCode; hostname?: string }

const BLOCK_TEXT: Record<BlockReason, string> = {
  scheme: 'Only http and https pages can be opened.',
  private_host: 'This address is on a private network and is blocked.',
  dns_fail: 'This host could not be found.',
  not_allowed_port: 'This port is not allowed.',
  no_binary: 'Chromium was not found on the server.',
  disabled: 'The browser is not turned on.',
  max_live: 'Too many browsers are active. Hide one first.',
}

const ERROR_TEXT: Record<BrowserErrorCode, string> = {
  lease_agent: 'An agent is driving this browser. Take over to use it.',
  human_active: 'You are using this browser.',
  stale_ref: 'The page has changed. Try again.',
  no_binary: BLOCK_TEXT.no_binary,
  disabled: BLOCK_TEXT.disabled,
  blocked: 'This address is blocked.',
  not_found: 'This browser session no longer exists.',
  too_large: 'Too large to send.',
  bad_request: 'The server rejected that input.',
  crashed: 'The page crashed. Reload to try again.',
}

/** Kode galat yang tidak hilang sendiri (butuh tindakan operator/pengguna). */
export const STICKY_ERRORS: ReadonlySet<BrowserErrorCode> = new Set(['no_binary', 'disabled', 'crashed'])

export interface BrowserNotice { tone: 'info' | 'error'; text: string }

/** Satu pesan status untuk overlay, atau null bila halaman tampil normal. */
export function browserNotice(i: { state?: BrowserState; error?: BrowserErr; connected: boolean }): BrowserNotice | null {
  const { state, error } = i
  const host = (h?: string) => (h ? ` (${h})` : '')
  if (state?.blocked) {
    // Saat navigasi ditolak, state.url masih halaman lama: host dari galat (bila ada) yang benar.
    const shown = error?.hostname ?? (state.url ? hostOnly(state.url) : undefined)
    return { tone: 'error', text: BLOCK_TEXT[state.blocked] + host(shown) }
  }
  if (error) return { tone: 'error', text: ERROR_TEXT[error.code] + host(error.code === 'blocked' ? error.hostname : undefined) }
  if (!i.connected) return { tone: 'info', text: 'Reconnecting…' }
  if (!state) return { tone: 'info', text: 'Connecting…' }
  return null
}

/** A failed main-frame navigation in words a user can act on (nodeterm `webviewError.ts`, keyed by name). */
export interface NetErrorText { title: string; hint: string; retryable: boolean }

const UNREACHABLE = "This site can't be reached"
const CHECK_ADDRESS = 'Check the address for typos.'
const CHECK_CONNECTION = 'Check your connection.'
const NOT_RUNNING = 'If this is a dev server, it may not be running yet.'
const UNTRUSTED = "The site's certificate isn't trusted."
const net = (title: string, hint: string, retryable = true): NetErrorText => ({ title, hint, retryable })

const NET_ERRORS: Record<string, NetErrorText> = {
  NAME_NOT_RESOLVED: net(UNREACHABLE, CHECK_ADDRESS),
  NAME_RESOLUTION_FAILED: net(UNREACHABLE, CHECK_ADDRESS),
  INTERNET_DISCONNECTED: net("You're offline", CHECK_CONNECTION),
  NETWORK_CHANGED: net('The network changed', CHECK_CONNECTION),
  CONNECTION_REFUSED: net(UNREACHABLE, `Nothing is listening at that address. ${NOT_RUNNING}`),
  CONNECTION_RESET: net(UNREACHABLE, 'The connection was reset.'),
  CONNECTION_CLOSED: net(UNREACHABLE, 'The server closed the connection.'),
  CONNECTION_TIMED_OUT: net(UNREACHABLE, 'The server took too long to respond.'),
  TIMED_OUT: net(UNREACHABLE, 'The server took too long to respond.'),
  CONNECTION_FAILED: net(UNREACHABLE, CHECK_CONNECTION),
  ADDRESS_UNREACHABLE: net(UNREACHABLE, 'That address is unreachable from this network.'),
  SSL_PROTOCOL_ERROR: net("This site can't provide a secure connection", 'The site sent an invalid response.'),
  TOO_MANY_REDIRECTS: net("This page isn't working", 'The site redirected too many times.'),
  EMPTY_RESPONSE: net("This page isn't working", 'The site sent no data.'),
  BLOCKED_BY_CLIENT: net('This page was blocked', 'Shields or a content blocker stopped it.', false),
  BLOCKED_BY_RESPONSE: net('This page was blocked', "The site doesn't allow being shown here.", false),
  INVALID_URL: net("This address can't be opened", CHECK_ADDRESS, false),
}
const CERT_ERROR = net('Your connection is not private', UNTRUSTED)
const UNKNOWN = net("This page couldn't load", '')

/**
 * Plate text for a Chromium net error name ("net::ERR_NAME_NOT_RESOLVED"); null for ERR_ABORTED (the user,
 * a download or a 204 cancelled it: nothing to explain). Unknown names get a generic sentence, never a guess.
 */
export function netErrorText(name: string): NetErrorText | null {
  const key = name.replace(/^net::ERR_/, '')
  if (key === 'ABORTED') return null
  return NET_ERRORS[key] ?? (key.startsWith('CERT_') ? CERT_ERROR : UNKNOWN)
}

/** Tombol pemulihan di bawah pesan: buka tawaran kemampuan Browser, izinkan satu host:port privat, atau plate galat jaringan. */
export type NoticeAction = { kind: 'offer' } | { kind: 'allowHost'; hostPort: string; entries: string[] }
  | ({ kind: 'netError'; code: string; host?: string } & NetErrorText)

const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1'])
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }
// Link-local (169.254/16 = metadata cloud, fe80::/10) tidak pernah ditawarkan sekali klik.
const NEVER_OFFER = /^(169\.254\.|\[?fe[89ab][0-9a-f]:)/i

/**
 * Aksi untuk pesan saat ini. `target` = URL yang terakhir diminta pengguna (state.url saat diblokir masih
 * halaman lama). Host localhost/127.0.0.1 diizinkan beserta aliasnya agar keduanya bisa dibuka.
 */
export function noticeAction(i: { state?: BrowserState; error?: BrowserErr; target?: string }): NoticeAction | null {
  const code = i.state?.blocked ?? i.error?.code
  if (code === 'no_binary' || code === 'disabled') return { kind: 'offer' }
  const ne = !code && i.state?.netError
  const text = ne ? netErrorText(ne) : null
  if (ne && text) return { kind: 'netError', code: ne, host: i.state?.url ? hostOnly(i.state.url) : undefined, ...text }
  if (i.state?.blocked !== 'private_host' || !i.target) return null
  let u: URL
  try { u = new URL(i.target) } catch { return null }
  const host = u.hostname.toLowerCase()
  if (NEVER_OFFER.test(host)) return null
  // Host yang benar-benar diblokir: cocok dengan galat server, atau (tanpa galat, mis. redirect) literal lokal/IP.
  // Nama DNS publik tanpa galat = blokir datang dari redirect, bukan dari target ini: jangan tawarkan.
  const literal = host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.startsWith('[')
  if (i.error?.hostname ? host.replace(/^\[|\]$/g, '') !== i.error.hostname.toLowerCase() : !literal) return null
  const port = u.port || DEFAULT_PORT[u.protocol]
  if (!port) return null
  const hosts = LOOPBACK_ALIASES.has(host) ? [...LOOPBACK_ALIASES] : [host]
  return { kind: 'allowHost', hostPort: `${host}:${port}`, entries: hosts.map((h) => `${h}:${port}`) }
}
