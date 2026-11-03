// Parser import cookie: Playwright `storageState` (atau array cookie polos) dan Netscape `cookies.txt`
// -> model internal. Galat HANYA berisi kode (+ nomor baris), tidak pernah potongan isi: pesan bawaan
// JSON.parse memuat cuplikan input, jadi sengaja dibuang. Nilai cookie = secret (Rule 7).
import { COOKIE_BODY_MAX_BYTES, type CookieFormat } from '../../shared/browser.contract'

export type SameSite = 'Strict' | 'Lax' | 'None'
/** Cookie internal (bentuk Playwright/CDP). `expires` detik unix, -1 = cookie sesi. */
export interface BrowserCookie {
  name: string; value: string; domain: string; path: string
  expires: number; httpOnly: boolean; secure: boolean; sameSite?: SameSite
}

export type CookieImportCode = 'too_large' | 'invalid_json' | 'invalid_shape' | 'invalid_cookie' | 'no_cookies'
/** Galat import yang aman ditampilkan/di-log: kode saja, tanpa isi berkas. */
export class CookieImportError extends Error {
  constructor(readonly code: CookieImportCode, readonly line?: number) {
    super(`cookie import: ${code}${line ? ` (line ${line})` : ''}`)
    this.name = 'CookieImportError'
  }
}

const HTTP_ONLY_PREFIX = '#HttpOnly_'
const NETSCAPE_MIN_FIELDS = 6 // 7 kolom; kolom value boleh hilang bila kosong (trailing tab terpangkas)
const SAME_SITE: Record<string, SameSite> = { strict: 'Strict', lax: 'Lax', none: 'None' }

/** Kunci pengelompokan domain: huruf kecil tanpa titik di depan. ponytail: bukan eTLD+1 (tanpa PSL); upgrade bila perlu. */
export function domainKey(domain: string): string {
  return domain.toLowerCase().replace(/^\./, '')
}

function fail(code: CookieImportCode, line?: number): never {
  throw new CookieImportError(code, line)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function fromJsonCookie(raw: unknown): BrowserCookie {
  if (typeof raw !== 'object' || raw === null) return fail('invalid_cookie')
  const r = raw as Record<string, unknown>
  const name = str(r.name)
  const value = str(r.value)
  const domain = str(r.domain)
  if (!name || value === undefined || !domain) return fail('invalid_cookie')
  const expires = typeof r.expires === 'number' && Number.isFinite(r.expires) && r.expires > 0 ? r.expires : -1
  return {
    name, value, domain: domain.toLowerCase(), path: str(r.path) || '/', expires,
    httpOnly: r.httpOnly === true, secure: r.secure === true,
    sameSite: SAME_SITE[(str(r.sameSite) ?? '').toLowerCase()],
  }
}

function parseStorageState(content: string): BrowserCookie[] {
  let data: unknown
  try { data = JSON.parse(content) } catch { return fail('invalid_json') } // pesan asli memuat cuplikan input
  const list = Array.isArray(data) ? data : (data as { cookies?: unknown } | null)?.cookies
  if (!Array.isArray(list)) return fail('invalid_shape')
  return list.map(fromJsonCookie)
}

function parseNetscape(content: string): BrowserCookie[] {
  const out: BrowserCookie[] = []
  content.split(/\r?\n/).forEach((raw, i) => {
    const httpOnly = raw.startsWith(HTTP_ONLY_PREFIX)
    const line = httpOnly ? raw.slice(HTTP_ONLY_PREFIX.length) : raw
    if (line.trim() === '' || (!httpOnly && line.startsWith('#'))) return
    const f = line.split('\t')
    if (f.length < NETSCAPE_MIN_FIELDS || !f[0] || !f[5]) return fail('invalid_cookie', i + 1)
    const [domain, subdomains, path, secure, expiry, name, value = ''] = f
    const exp = Number(expiry)
    if (!Number.isFinite(exp)) return fail('invalid_cookie', i + 1)
    const lower = domain.toLowerCase()
    out.push({
      name, value, path: path || '/', secure: secure.toUpperCase() === 'TRUE', httpOnly,
      domain: subdomains.toUpperCase() === 'TRUE' && !lower.startsWith('.') ? `.${lower}` : lower,
      expires: exp > 0 ? exp : -1,
    })
  })
  return out
}

/** Parse isi berkas import; melempar `CookieImportError` (tanpa isi) bila ukuran/format salah. */
export function parseCookies(format: CookieFormat, content: string): BrowserCookie[] {
  if (Buffer.byteLength(content, 'utf8') > COOKIE_BODY_MAX_BYTES) fail('too_large')
  const cookies = format === 'netscape' ? parseNetscape(content) : parseStorageState(content)
  if (cookies.length === 0) fail('no_cookies')
  return cookies
}
