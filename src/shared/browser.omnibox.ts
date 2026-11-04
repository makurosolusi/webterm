// Omnibox node browser: ketikan bilah alamat / halaman awal -> URL tujuan atau pencarian.
// Portions adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc. — see THIRD_PARTY_NOTICES.md
// Port dari Orca (MIT) `src/shared/browser-url.ts` `normalizeBrowserNavigationUrl` + `looksLikeSearchQuery`,
// dimodifikasi untuk guard webterm: TANPA cabang file:/path lokal, dan setiap hasil (termasuk URL
// pencarian) tetap lewat `parseBrowserUrl` — jadi hanya http(s) tanpa userinfo yang pernah keluar.
import { parseBrowserUrl, type ParsedBrowserUrl } from './browser.url'

export type SearchEngine = 'google' | 'duckduckgo' | 'bing' | 'kagi'

/** Pilihan mesin pencari (label + awalan URL; kueri ditempel ter-encode). Urutan = urutan di Settings. */
export const SEARCH_ENGINES: Record<SearchEngine, { label: string; prefix: string }> = {
  google: { label: 'Google', prefix: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', prefix: 'https://duckduckgo.com/?q=' },
  bing: { label: 'Bing', prefix: 'https://www.bing.com/search?q=' },
  kagi: { label: 'Kagi', prefix: 'https://kagi.com/search?q=' },
}
export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'google'

// localhost / 127.x / 0.0.0.0 / [IPv6] tanpa skema -> http (server dev lokal jarang ber-TLS).
const LOCAL_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i
// Ketikan berbentuk domain bertitik = navigasi; prosa polos seperti "react hooks" tetap pencarian.
const LOOKS_LIKE_URL = /^[^\s]+\.[a-z]{2,}(\/.*)?$/i
const DOMAIN_PORT = /^([^\s/\\:@?#]+):\d+(?:[/?#].*)?$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Nilai setting -> mesin dikenal (nilai bisa diedit tangan; tak dikenal jatuh ke default). */
export function toSearchEngine(v: unknown): SearchEngine {
  return typeof v === 'string' && v in SEARCH_ENGINES ? (v as SearchEngine) : DEFAULT_SEARCH_ENGINE
}

/** URL pencarian untuk `query` di `engine`. */
export function buildSearchUrl(query: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string {
  // Lone surrogate membuat encodeURIComponent melempar; ganti dengan U+FFFD (setara toWellFormed di Orca).
  const wellFormed = query.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
  return SEARCH_ENGINES[toSearchEngine(engine)].prefix + encodeURIComponent(wellFormed)
}

/** Ada spasi -> kueri; berbentuk domain atau memuat titik/titik dua -> alamat; selain itu kueri. */
export function looksLikeSearchQuery(input: string): boolean {
  if (input.includes(' ')) return true
  if (LOOKS_LIKE_URL.test(input)) return false
  return !(input.includes('.') || input.includes(':'))
}

// `host.tld:port` tanpa skema: tanpa ini `new URL` membaca `host.tld` sebagai skema. `.localhost` -> http.
function domainPortAddress(input: string): string | null {
  const m = DOMAIN_PORT.exec(input)
  if (!m || !m[1].includes('.')) return null
  try {
    const host = new URL(`https://${input}`).hostname.toLowerCase().replace(/\.$/, '')
    if (host.length > 253 || !host.split('.').every((l) => l.length <= 63 && DNS_LABEL.test(l))) return null
    return `${host.endsWith('.localhost') ? 'http' : 'https'}://${input}`
  } catch {
    return null // bukan host valid -> biarkan cabang berikutnya memutuskan
  }
}

function candidate(text: string, engine: SearchEngine): string {
  if (LOCAL_ADDRESS.test(text)) return `http://${text}`
  const domainPort = domainPortAddress(text)
  if (domainPort) return domainPort
  try {
    new URL(text)
    return text // skema eksplisit apa pun: http(s) lolos guard, selain itu (javascript:/file:/…) ditolak guard
  } catch {
    // Tanpa skema: tebak https bila bentuknya alamat, selain itu pencarian.
  }
  try {
    new URL(`https://${text}`)
    if (!looksLikeSearchQuery(text)) return `https://${text}`
  } catch {
    // Bahkan dengan https:// tak terurai (mis. ada spasi di host) -> pencarian.
  }
  return buildSearchUrl(text, engine)
}

/**
 * Ketikan omnibox -> URL tujuan yang sudah lolos `parseBrowserUrl`, atau penolakannya (skema
 * terlarang/userinfo/terlalu panjang). null bila kosong.
 */
export function resolveOmniboxInput(raw: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): ParsedBrowserUrl | null {
  const text = raw.trim()
  if (!text) return null
  return parseBrowserUrl(candidate(text, engine))
}
