// Penjaga navigasi lapis-1 (skema + host, TANPA DNS) dan lapis-2 (`Page.frameNavigated` diverifikasi ulang).
// DNS/IP sebenarnya dijaga proxy (ssrf.proxy.ts); guard ini menangkap literal IP/localhost/port sendiri lebih awal.
import { BlockedError, type BlockReason } from '../../shared/browser.contract'
import { hostOnly, parseBrowserUrl } from '../../shared/browser.url'
import { isAllowed, isLocalName, normalizeHost, type AllowSet } from './ssrf.allowlist'
import { classifyIp } from './ssrf.ip'
import { isIP } from 'node:net'

/** URL kosong yang aman: tujuan pemulihan setelah navigasi diblokir. */
export const BLANK_URL = 'about:blank'
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

export type GuardResult = { ok: true; url: string } | { ok: false; reason: BlockReason; hostname: string }

export interface NavigationGuard {
  /** Periksa URL tujuan (skema + host, tanpa DNS). */
  check(url: string): GuardResult
  /** Seperti `check` tapi melempar `BlockedError` (hostname saja) dan mengembalikan URL ternormalisasi. */
  assert(url: string): string
  /** Verifikasi ulang URL frame hasil navigasi/redirect; `about:blank` lolos. Gagal = pemanggil kembali ke `BLANK_URL` + `blocked`. */
  onFrameNavigated(url: string): GuardResult
}

export interface GuardOptions {
  /** Allowlist host:port; fungsi = dibaca ulang tiap cek (allowlist Pengaturan berlaku tanpa restart). */
  allow: AllowSet | (() => AllowSet)
  webtermPort: number
  /** Webterm bind loopback: localhost/127.0.0.1/::1 (dev server) boleh tanpa allowlist, KECUALI port webterm. */
  allowLoopback?: boolean
}

/** Set tetap atau getter -> set saat ini. */
export const allowNow = (a: AllowSet | (() => AllowSet)): AllowSet => (typeof a === 'function' ? a() : a)

/** Buat penjaga navigasi; `allow` = allowlist host:port, `webtermPort` = port webterm (hard-deny pada loopback). */
export function createNavigationGuard({ allow, webtermPort, allowLoopback = false }: GuardOptions): NavigationGuard {
  const check = (raw: string): GuardResult => {
    const parsed = parseBrowserUrl(raw)
    if (!parsed.ok) return { ok: false, reason: 'scheme', hostname: hostOnly(typeof raw === 'string' ? raw : '') }
    const { protocol, port } = new URL(parsed.url)
    const host = normalizeHost(parsed.host)
    const portNum = port ? Number(port) : DEFAULT_PORTS[protocol]
    const block = (reason: BlockReason): GuardResult => ({ ok: false, reason, hostname: host })
    if (portNum === webtermPort && isLocalName(host)) return block('not_allowed_port')
    if (isAllowed(allowNow(allow), host, portNum)) return { ok: true, url: parsed.url }
    // localhost = dev server: di mesin sendiri tak ada batas jaringan yang dilanggar.
    if (allowLoopback && isLocalName(host)) return { ok: true, url: parsed.url }
    if (isLocalName(host) || (isIP(host) !== 0 && classifyIp(host) === 'private')) return block('private_host')
    return { ok: true, url: parsed.url }
  }
  return {
    check,
    assert(url) {
      const r = check(url)
      if (!r.ok) throw new BlockedError(r.reason, r.hostname)
      return r.url
    },
    onFrameNavigated: (url) => (url === BLANK_URL ? { ok: true, url } : check(url)),
  }
}
