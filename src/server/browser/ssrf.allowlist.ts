// Allowlist `WEBTERM_BROWSER_ALLOW_HOSTS` (daftar `host:port`, default kosong). Port webterm sendiri pada
// loopback = hard-deny: seluruh daftar ditolak, bukan hanya entrinya (P-5).
import { isIP } from 'node:net'
import { isLoopbackOrUnspecified } from './ssrf.ip'

/** Himpunan kunci `host:port` ternormalisasi (host huruf kecil, tanpa kurung/titik akhir). */
export type AllowSet = ReadonlySet<string>
export type AllowParse = { ok: true; hosts: AllowSet } | { ok: false; reason: string }

const PORT_MAX = 65_535
const ENTRY_RE = /^(\[[0-9a-f:.%]+\]|[^:[\]\s/]+):(\d{1,5})$/i

/** Huruf kecil, buang kurung IPv6 dan titik akhir FQDN. */
export const normalizeHost = (host: string): string =>
  host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')

/** Kunci pencarian allowlist. */
export const allowKey = (host: string, port: number): string => `${normalizeHost(host)}:${port}`

/** True bila host:port ada di allowlist. */
export const isAllowed = (allow: AllowSet, host: string, port: number): boolean => allow.has(allowKey(host, port))

/** Nama/IP yang menunjuk mesin ini (localhost, *.localhost, IP loopback/unspecified). */
export function isLocalName(host: string): boolean {
  const h = normalizeHost(host)
  return h === 'localhost' || h.endsWith('.localhost') || (isIP(h) !== 0 && isLoopbackOrUnspecified(h))
}

/** Parse env (dipisah koma/spasi). Entri rusak atau memuat `webtermPort` pada loopback menolak SELURUH daftar. */
export function parseAllowHosts(raw: string | undefined, webtermPort: number): AllowParse {
  const hosts = new Set<string>()
  for (const entry of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const m = ENTRY_RE.exec(entry)
    const port = m ? Number(m[2]) : 0
    if (!m || port < 1 || port > PORT_MAX) return { ok: false, reason: `invalid allow entry "${entry}" (expected host:port)` }
    if (port === webtermPort && isLocalName(m[1])) {
      return { ok: false, reason: `allow entry "${entry}" targets the webterm port on loopback (hard-deny)` }
    }
    hosts.add(allowKey(m[1], port))
  }
  return { ok: true, hosts }
}
