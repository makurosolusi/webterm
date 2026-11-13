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

// Hosts Chrome opens over http when typed without a scheme: loopback, RFC 1918 private ranges,
// link-local, IPv6 literals, `*.localhost` and mDNS `*.local` (LAN dev servers rarely have TLS).
const PRIVATE_V4 = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
// A single-label intranet host with a port (`intranet:8080`); without the port a bare word is a search.
const SINGLE_LABEL_PORT = /^[a-z0-9-]+:\d+(?:[/?#].*)?$/i
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

const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.startsWith('[') ||
  (IPV4.test(host) && PRIVATE_V4.test(host))

// Scheme-less local/LAN/intranet address -> `http://…`, else null.
function localAddress(input: string): string | null {
  if (/\s/.test(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return null
  let host: string
  try {
    host = new URL(`http://${input}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null // `javascript:…`, `about:blank` and the like: an explicit scheme, decided further on
  }
  const intranet = SINGLE_LABEL_PORT.test(input) && DNS_LABEL.test(host)
  return intranet || isLocalHost(host) ? `http://${input}` : null
}

// `host.tld:port` tanpa skema: tanpa ini `new URL` membaca `host.tld` sebagai skema.
function domainPortAddress(input: string): string | null {
  const m = DOMAIN_PORT.exec(input)
  if (!m || !m[1].includes('.')) return null
  try {
    const host = new URL(`https://${input}`).hostname.toLowerCase().replace(/\.$/, '')
    if (host.length > 253 || !host.split('.').every((l) => l.length <= 63 && DNS_LABEL.test(l))) return null
    return `https://${input}`
  } catch {
    return null // bukan host valid -> biarkan cabang berikutnya memutuskan
  }
}

/** The address `text` names, or null when it reads as a search query. */
function address(text: string): string | null {
  const local = localAddress(text)
  if (local) return local
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
  return null
}

/**
 * Ketikan omnibox -> URL tujuan yang sudah lolos `parseBrowserUrl`, atau penolakannya (skema
 * terlarang/userinfo/terlalu panjang). null bila kosong.
 */
export function resolveOmniboxInput(raw: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): ParsedBrowserUrl | null {
  const text = raw.trim()
  if (!text) return null
  return parseBrowserUrl(address(text) ?? buildSearchUrl(text, engine))
}

/**
 * Address-only variant for URL fields (start-page shortcuts): the same local/LAN/https rules, and
 * where the omnibox would search, a bare word becomes `https://word/` (Chrome's URL fixup). null when empty.
 */
export function resolveOmniboxAddress(raw: string): ParsedBrowserUrl | null {
  const text = raw.trim()
  if (!text) return null
  return parseBrowserUrl(address(text) ?? `https://${text}`)
}
