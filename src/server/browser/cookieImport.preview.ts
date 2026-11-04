// Preview import cookie in-memory (TTL): konten TIDAK pernah ditulis ke disk. Preview terikat workspace
// dan sekali pakai; ringkasan keluar hanya domain + jumlah (tanpa nama/nilai cookie).
import { randomUUID } from 'node:crypto'
import { COOKIE_PREVIEW_TTL_MS, type CookiePreviewResp } from '../../shared/browser.contract'
import { domainKey, type BrowserCookie } from './cookieImport.parse'
import { partitionImportableCookies } from './cookieImportPolicy'

const MAX_PREVIEWS = 16 // batas memori: maks ~16 x COOKIE_BODY_MAX_BYTES; yang tertua digusur

interface Entry { workspaceId: string; cookies: BrowserCookie[]; expiresAt: number }

export interface CookiePreviewStore {
  /** Simpan hasil parse TANPA cookie login Google; kembalikan ringkasan domain (tanpa nilai). */
  put(workspaceId: string, cookies: BrowserCookie[]): CookiePreviewResp
  /** Ambil (dan hapus) cookie subset domain; null bila id tak dikenal/kedaluwarsa/beda workspace. */
  take(previewId: string, workspaceId: string, domains: string[]): BrowserCookie[] | null
}

/** Buat store preview; `now`/`ttlMs` diinjeksi untuk test. */
export function createCookiePreviewStore(opts: { now?: () => number; ttlMs?: number } = {}): CookiePreviewStore {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? COOKIE_PREVIEW_TTL_MS
  const entries = new Map<string, Entry>() // urutan sisip = urutan umur

  function sweep(): void {
    const t = now()
    for (const [id, e] of entries) if (e.expiresAt <= t) entries.delete(id)
  }

  return {
    put(workspaceId, parsed) {
      sweep()
      // Filter di sini = satu titik: commit hanya bisa `take` dari set yang sudah difilter.
      const { importable: cookies, googleSkipped } = partitionImportableCookies(parsed)
      while (entries.size >= MAX_PREVIEWS) entries.delete(entries.keys().next().value as string)
      const previewId = randomUUID()
      const expiresAt = now() + ttlMs
      entries.set(previewId, { workspaceId, cookies, expiresAt })
      const byDomain = new Map<string, { count: number; hasSession: boolean }>()
      for (const c of cookies) {
        const d = byDomain.get(domainKey(c.domain)) ?? { count: 0, hasSession: false }
        d.count++
        d.hasSession ||= c.expires === -1
        byDomain.set(domainKey(c.domain), d)
      }
      const domains = [...byDomain].map(([domain, v]) => ({ domain, ...v })).sort((a, b) => a.domain.localeCompare(b.domain))
      return { previewId, domains, expiresAt, googleSkipped }
    },
    take(previewId, workspaceId, domains) {
      sweep()
      const e = entries.get(previewId)
      if (!e || e.workspaceId !== workspaceId) return null
      entries.delete(previewId)
      const wanted = new Set(domains.map(domainKey))
      return e.cookies.filter((c) => wanted.has(domainKey(c.domain)))
    },
  }
}
