// Daftar halaman terakhir dibuka (per klien, localStorage). Tidak ada endpoint server.
import { parseBrowserUrl } from '../shared/browser.url'

export const RECENT_STORAGE_KEY = 'webterm.browser.recent'
export const RECENT_MAX = 6
const TITLE_MAX = 120 // judul halaman asing: dipotong agar localStorage dan daftar tidak membengkak

export interface RecentItem { url: string; host: string; title: string }

/** Origin + path saja: query/hash sering memuat token/sesi, jadi tidak pernah disimpan. */
function sanitize(rawUrl: string, title: string): RecentItem | null {
  const p = parseBrowserUrl(rawUrl)
  if (!p.ok) return null // juga menolak skema non-http(s) dan userinfo
  const u = new URL(p.url)
  return { url: u.origin + u.pathname, host: p.host, title: title.trim().slice(0, TITLE_MAX) }
}

const isItem = (x: unknown): x is RecentItem => {
  const o = x as Record<string, unknown> | null
  return !!o && typeof o.url === 'string' && typeof o.host === 'string' && typeof o.title === 'string'
}

/** Baca daftar tersimpan; storage rusak/diblokir/JSON jelek -> daftar kosong (dengan warn, tanpa hostname). */
export function loadRecent(): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]')
    // Re-sanitize saat baca: data lama/diedit manual tidak boleh lolos membawa query atau skema lain.
    return Array.isArray(parsed)
      ? parsed.filter(isItem).map((i) => sanitize(i.url, i.title)).filter((i): i is RecentItem => i !== null).slice(0, RECENT_MAX)
      : []
  } catch (e) {
    console.warn('browser.recent load failed', e instanceof Error ? e.name : 'unknown')
    return []
  }
}

/** Tambah halaman ke depan daftar (dedupe per host, batas `RECENT_MAX`); mengembalikan daftar baru. */
export function addRecent(rawUrl: string, title: string): RecentItem[] {
  const item = sanitize(rawUrl, title)
  const current = loadRecent()
  if (!item) return current
  const next = [item, ...current.filter((i) => i.host !== item.host)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
  } catch (e) {
    // Kuota penuh / mode privat: daftar tetap dikembalikan untuk sesi ini, hanya tidak persisten.
    console.warn('browser.recent save failed', e instanceof Error ? e.name : 'unknown')
  }
  return next
}
