// Rute cookie `/api/browser/:workspaceId/cookies/*` (PLAN b §4.5). Cookie = secret kelas tertinggi (Rule 7):
// tidak ada respons/log yang memuat nama atau nilai cookie; log hanya lewat `cookieLogEntry`. Otorisasi
// (Origin + token root) terjadi di gerbang `/api/*` di index.ts, bukan di sini.
import { COOKIE_BODY_MAX_BYTES } from '../shared/browser.contract'
import type { CookieCommitResp, CookieFormat, CookiePreviewResp } from '../shared/browser.contract'
import { BodyReadError } from './cappedRequestBody'
import { CookieImportError, domainKey, parseCookies } from './browser/cookieImport.parse'
import type { BrowserCookie } from './browser/cookieImport.parse'
import type { CookiePreviewStore } from './browser/cookieImport.preview'
import { cookieLogEntry } from './browser/cookieRedact'
import type { CookieAction } from './browser/cookieRedact'
import type { CookieVault } from './browser/cookieVault.store'
import { createLogger } from './logs'

const log = createLogger('browser.cookies')

/** Status + body JSON (`body` absen = 204 tanpa isi). */
export type BrowserApiResult = { status: number; body?: unknown; headers?: Record<string, string> }

/** Batas getter body untuk rute browser: konten <= COOKIE_BODY_MAX_BYTES, dilipat ganda oleh escape JSON + amplop. */
export const BROWSER_BODY_MAX_BYTES = COOKIE_BODY_MAX_BYTES * 2 + 4096

/** Penyuntik cookie ke profil Chromium (host: `Network.setCookies` internal, BUKAN lewat allowlist agent). */
export interface CookieInjector {
  /** Suntik cookie ke profil workspace; melempar bila gagal. */
  inject(workspaceId: string, cookies: BrowserCookie[]): Promise<void>
  /** Hapus cookie dari profil workspace (satu domain, atau semua bila `domain` kosong). */
  remove(workspaceId: string, domain?: string): Promise<void>
}

export interface CookieApiDeps {
  vault: CookieVault
  preview: CookiePreviewStore
  injector: CookieInjector
  /** Import (preview/commit) hanya aktif bila flag `cookieImport` menyala. */
  cookieImportEnabled(): boolean
}

export const fail = (status: number, error: string, extra: object = {}): BrowserApiResult => ({ status, body: { error, ...extra } })
const NO_CONTENT: BrowserApiResult = { status: 204 }

/** Baca body sebagai objek JSON biasa; '' = objek kosong. Penolakan cap -> 413/400, bukan 500. */
export async function readObject(
  body: () => Promise<string>
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: BrowserApiResult }> {
  let raw: string
  try {
    raw = await body()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return { ok: false, result: err.reason === 'too_large' ? fail(413, 'payload_too_large') : fail(400, 'bad_request', { reason: 'body_read_failed' }) }
  }
  if (raw === '') return { ok: true, value: {} }
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> }
  } catch {
    // JSON rusak -> jatuh ke 400 di bawah; pesan JSON.parse memuat cuplikan input, sengaja dibuang.
  }
  return { ok: false, result: fail(400, 'bad_request', { reason: 'bad_json' }) }
}

function logAction(action: CookieAction, workspaceId: string, cookies: ReadonlyArray<{ domain: string }>): void {
  const { domains, count } = cookieLogEntry(action, workspaceId, cookies)
  log.info('browser.cookies', `Cookie ${action}`, { ids: { workspaceId }, domains, count, action })
}

function logFailure(action: CookieAction, workspaceId: string, err: unknown): void {
  // Hanya nama kelas galat: pesan galat bisa membawa konteks tak terduga dan cookie = secret.
  log.error('browser.cookies.fail', `Cookie ${action} failed`, { ids: { workspaceId }, action, error: err instanceof Error ? err.name : 'unknown' })
}

const isFormat = (v: unknown): v is CookieFormat => v === 'storageState' || v === 'netscape'

async function preview(workspaceId: string, body: () => Promise<string>, d: CookieApiDeps): Promise<BrowserApiResult> {
  if (!d.cookieImportEnabled()) return fail(404, 'disabled')
  const read = await readObject(body)
  if (!read.ok) return read.result
  const { format, content } = read.value
  if (!isFormat(format) || typeof content !== 'string') return fail(400, 'bad_request')
  try {
    const cookies = parseCookies(format, content)
    const resp: CookiePreviewResp = d.preview.put(workspaceId, cookies)
    logAction('preview', workspaceId, cookies)
    return { status: 200, body: resp }
  } catch (err) {
    if (!(err instanceof CookieImportError)) throw err
    // `err.code` + nomor baris saja: aman ditampilkan (parser tak pernah memasukkan isi berkas).
    return err.code === 'too_large' ? fail(413, 'payload_too_large') : fail(400, 'bad_request', { reason: err.code, ...(err.line ? { line: err.line } : {}) })
  }
}

async function commit(workspaceId: string, body: () => Promise<string>, d: CookieApiDeps): Promise<BrowserApiResult> {
  if (!d.cookieImportEnabled()) return fail(404, 'disabled')
  const read = await readObject(body)
  if (!read.ok) return read.result
  const { previewId, domains } = read.value
  if (typeof previewId !== 'string' || !Array.isArray(domains) || domains.length === 0 || !domains.every((x) => typeof x === 'string' && x !== '')) {
    return fail(400, 'bad_request')
  }
  const cookies = d.preview.take(previewId, workspaceId, domains as string[])
  if (!cookies) return fail(404, 'not_found') // id tak dikenal / kedaluwarsa / milik workspace lain
  if (cookies.length === 0) return fail(400, 'bad_request', { reason: 'no_matching_domains' })
  try {
    await d.injector.inject(workspaceId, cookies) // profil dulu: gagal suntik = vault tidak berubah
    d.vault.save(workspaceId, cookies)
  } catch (err) {
    logFailure('commit', workspaceId, err)
    throw err
  }
  logAction('commit', workspaceId, cookies)
  const resp: CookieCommitResp = { imported: cookies.length, domains: [...new Set(cookies.map((c) => domainKey(c.domain)))].sort() }
  return { status: 200, body: resp }
}

function domains(workspaceId: string, d: CookieApiDeps): BrowserApiResult {
  try {
    return { status: 200, body: { domains: d.vault.listDomains(workspaceId) } }
  } catch (err) {
    logFailure('list', workspaceId, err)
    throw err
  }
}

async function clear(workspaceId: string, pathDomain: string | undefined, body: () => Promise<string>, d: CookieApiDeps): Promise<BrowserApiResult> {
  const read = await readObject(body)
  if (!read.ok) return read.result
  const domain = pathDomain ?? read.value.domain
  if (domain !== undefined && (typeof domain !== 'string' || domain === '')) return fail(400, 'bad_request')
  try {
    d.vault.clear(workspaceId, domain)
    await d.injector.remove(workspaceId, domain)
  } catch (err) {
    logFailure('clear', workspaceId, err)
    throw err
  }
  logAction('clear', workspaceId, domain === undefined ? [] : [{ domain }])
  return NO_CONTENT
}

/** Rute cookie satu workspace; `rest` = segmen setelah `cookies` (kosong, `domains`, `preview`, `commit`, atau domain untuk DELETE). */
export function cookieRoute(
  method: string, workspaceId: string, rest: string[], body: () => Promise<string>, d: CookieApiDeps
): Promise<BrowserApiResult> | BrowserApiResult | null {
  const [head, ...tail] = rest
  if (head === 'domains' && !tail.length && method === 'GET') return domains(workspaceId, d)
  if (head === 'preview' && !tail.length && method === 'POST') return preview(workspaceId, body, d)
  if (head === 'commit' && !tail.length && method === 'POST') return commit(workspaceId, body, d)
  if (method === 'DELETE' && rest.length <= 1) return clear(workspaceId, head, body, d)
  return null
}
