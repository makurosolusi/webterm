import { parseBrowserUrl } from '../shared/browser.url'

/** Tipe data drag yang mungkin membawa URL; dipakai juga oleh dragover untuk memutuskan menerima drop. */
export const DROP_URL_TYPES = ['text/uri-list', 'text/plain'] as const

const URI_LIST = 'text/uri-list'
const PLAIN = 'text/plain'

/** URL http(s) valid dari drop (uri-list dulu, lalu teks polos), atau null; `files` sengaja diabaikan. */
export function urlFromDrop(dt: { getData(type: string): string }): string | null {
  // Baris pertama uri-list yang bukan komentar (`#`); format itu menyisipkan komentar di depan.
  const fromList = dt.getData(URI_LIST).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'))
  // Validasi tunggal di parseBrowserUrl (skema, userinfo, panjang) agar drop tak punya aturan sendiri.
  const parsed = parseBrowserUrl(fromList ?? dt.getData(PLAIN).trim())
  return parsed.ok ? parsed.url : null
}
