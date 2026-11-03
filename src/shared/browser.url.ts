// Validasi URL node browser dan bentuk aman-log (§4.1/c §6.1). Murni; dipakai di SEMUA pintu
// (nav klien, verb agent, `WsNode.url` saat restore). Hanya http/https.
import { URL_MAX_CHARS } from './browser.contract'

/** Semua alasan dipetakan ke `BlockReason` 'scheme' oleh pemanggil. */
export type UrlRejectReason = 'invalid' | 'scheme' | 'userinfo' | 'too_long'
export type ParsedBrowserUrl = { ok: true; url: string; host: string } | { ok: false; reason: UrlRejectReason }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
export const HOST_INVALID = '(invalid)'

/** Terima hanya http(s) tanpa userinfo; `url` = bentuk ternormalisasi, `host` = hostname tanpa port. Penolakan tak pernah memuat URL. */
export function parseBrowserUrl(raw: unknown): ParsedBrowserUrl {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  const s = raw.trim()
  if (s.length > URL_MAX_CHARS) return { ok: false, reason: 'too_long' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: 'invalid' } // tanpa skema / tak terurai; tidak ada tebakan "https://"
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return { ok: false, reason: 'scheme' }
  if (u.username || u.password) return { ok: false, reason: 'userinfo' }
  return { ok: true, url: u.href, host: u.hostname }
}

/** Hostname saja untuk log (tanpa skema/port/path/query/credential); `(invalid)` bila tak terurai. */
export function hostOnly(url: string): string {
  try {
    return new URL(url).hostname || HOST_INVALID
  } catch {
    return HOST_INVALID // jangan pernah mengecho input mentah ke log
  }
}
