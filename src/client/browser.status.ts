// Teks status overlay node browser. Murni; hanya hostname yang pernah ditampilkan (tanpa URL berquery).
import type { BlockReason, BrowserErrorCode, BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'

export interface BrowserErr { code: BrowserErrorCode; hostname?: string }

const BLOCK_TEXT: Record<BlockReason, string> = {
  scheme: 'Hanya halaman http dan https yang bisa dibuka.',
  private_host: 'Alamat ini ada di jaringan privat dan diblokir.',
  dns_fail: 'Host ini tidak bisa ditemukan.',
  not_allowed_port: 'Port ini tidak diizinkan.',
  no_binary: 'Chromium belum ditemukan di server.',
  disabled: 'Browser belum menyala.',
  max_live: 'Terlalu banyak browser aktif. Sembunyikan salah satu dulu.',
}

const ERROR_TEXT: Record<BrowserErrorCode, string> = {
  lease_agent: 'Agent sedang mengendalikan browser ini. Ambil alih untuk memakainya.',
  lease_human: 'Kamu yang mengendalikan browser ini.',
  human_active: 'Kamu sedang memakai browser ini.',
  stale_ref: 'Halaman sudah berubah. Coba lagi.',
  no_binary: BLOCK_TEXT.no_binary,
  disabled: BLOCK_TEXT.disabled,
  blocked: 'Alamat ini diblokir.',
  not_found: 'Sesi browser ini sudah tidak ada.',
  too_large: 'Terlalu besar untuk dikirim.',
  bad_request: 'Server menolak masukan itu.',
  crashed: 'Halaman macet. Muat ulang untuk mencoba lagi.',
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
  if (!i.connected) return { tone: 'info', text: 'Menyambung ulang…' }
  if (!state) return { tone: 'info', text: 'Menyambung…' }
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
