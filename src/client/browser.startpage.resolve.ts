// Ubah ketikan di kotak halaman awal menjadi URL tujuan: alamat -> navigasi, selain itu -> pencarian.
import { parseBrowserUrl } from '../shared/browser.url'
import { SEARCH_URL_PREFIX } from './browser.startpage.data'

// host berformat domain/localhost/IPv4, opsional port + path; sengaja tanpa spasi.
const HOST_LIKE = /^(localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i
const LOCAL_HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?=[:/?#]|$)/i

/** URL tujuan untuk ketikan `raw`, atau null bila kosong. Tidak pernah menghasilkan skema selain http(s). */
export function resolveStartInput(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const full = parseBrowserUrl(text)
  if (full.ok) return full.url
  if (HOST_LIKE.test(text)) {
    // Alamat lokal umumnya tak punya TLS; selain itu https lebih aman sebagai tebakan.
    const guess = parseBrowserUrl(`${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`)
    if (guess.ok) return guess.url
  }
  return SEARCH_URL_PREFIX + encodeURIComponent(text)
}
