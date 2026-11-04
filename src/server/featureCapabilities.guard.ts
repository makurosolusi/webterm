// Penjaga tak terlihat untuk mutasi pengaturan/kemampuan: pengguna tidak melihat token atau dialog,
// server tetap menolak proses lain yang bukan pemilik (token node, proxy, halaman asing).
// Kenapa bukan token wajib: webterm untuk satu pengguna loopback; gesekan token dibuang, bukan pagarnya.
// Penolakan selalu 403 `forbidden` generik; klien menerjemahkannya jadi sebab + jalan keluar (buka lewat
// http://127.0.0.1:<port> atau aktifkan token akses, lihat `forbiddenText` di capabilitiesLabels.ts).
import type { IncomingMessage } from 'node:http'
import { CAPABILITY_HEADER, TOKEN_HEADER, sameOrigin, tokensMatch } from './auth'
import { firstHeader } from './httpHeaders'
import { buildAllowedHosts, hostAllowed } from './hostAllow'
import { createLogger } from './logs'
import { resolveHostPort } from './serverConfig'
import { getTokenState } from './tokenBootstrap'

const log = createLogger('capabilities')

/** Alasan penolakan; generik, tidak pernah memuat isi header. */
export type GuardReason = 'forwarded' | 'origin' | 'token_kind' | 'peer' | 'host'
/** `token` = token root valid; `ui` = jalur tanpa token (loopback, sama-origin). */
export type GuardResult = { ok: true; via: 'token' | 'ui' } | { ok: false; reason: GuardReason }

/** Peer loopback dilihat dari socket; header proxy tidak dipercaya (bisa dipalsukan). */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const FORWARDED_HEADER = 'forwarded'
const FORWARDED_PREFIX = 'x-forwarded-'

/** Peer permintaan: loopback atau remote (dari socket). */
export function peerOf(req: IncomingMessage): 'loopback' | 'remote' {
  const addr = req.socket?.remoteAddress
  return addr !== undefined && LOOPBACK_PEERS.has(addr) ? 'loopback' : 'remote'
}

const forwarded = (req: IncomingMessage): boolean =>
  Object.keys(req.headers ?? {}).some((h) => h === FORWARDED_HEADER || h.startsWith(FORWARDED_PREFIX))

/** Host lolos allowlist yang sama dengan boot (loopback + bind + WEBTERM_ALLOWED_HOSTS); gagal baca konfigurasi = ditolak. */
function hostOk(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  try {
    return hostAllowed(req.headers?.host, buildAllowedHosts({ ...resolveHostPort(env), env }))
  } catch (err) {
    log.warn('guard.host_config', 'Cannot resolve host allowlist for settings guard', { cause: err instanceof Error ? err.name : 'error' })
    return false
  }
}

/** Origin WAJIB ada dan sama-origin: browser selalu mengirimnya pada PUT/POST; skrip tanpa Origin ditolak. */
const originPresentAndSame = (req: IncomingMessage): boolean => {
  const origin = firstHeader(req.headers?.origin)
  return typeof origin === 'string' && origin !== '' && sameOrigin(req.headers)
}

/**
 * Putuskan apakah mutasi boleh lanjut. (A) token root valid; (B) tanpa token ditegakkan DAN peer loopback,
 * tanpa header forwarded, Host lolos allowlist, Origin ada dan sama. Token node/capability selalu ditolak.
 */
export function settingsGuard(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env, rootToken: string | undefined = getTokenState().token): GuardResult {
  const presented = firstHeader(req.headers?.[TOKEN_HEADER]) || undefined
  const capability = firstHeader(req.headers?.[CAPABILITY_HEADER]) || undefined
  if (rootToken !== undefined) {
    return presented !== undefined && capability === undefined && tokensMatch(rootToken, presented)
      ? { ok: true, via: 'token' }
      : { ok: false, reason: 'token_kind' }
  }
  if (presented !== undefined || capability !== undefined) return { ok: false, reason: 'token_kind' }
  if (forwarded(req)) return { ok: false, reason: 'forwarded' }
  if (peerOf(req) !== 'loopback') return { ok: false, reason: 'peer' }
  if (!hostOk(req, env)) return { ok: false, reason: 'host' }
  if (!originPresentAndSame(req)) return { ok: false, reason: 'origin' }
  return { ok: true, via: 'ui' }
}
