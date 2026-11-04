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
  lease_human: 'You are driving this browser.',
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

/** Tombol pemulihan di bawah pesan: buka tawaran kemampuan Browser, atau izinkan satu host:port privat. */
export type NoticeAction = { kind: 'offer' } | { kind: 'allowHost'; hostPort: string; entries: string[] }

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
