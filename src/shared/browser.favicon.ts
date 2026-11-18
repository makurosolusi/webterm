// Page favicon selection (Chrome/Edge rules, 16px at 2x density). Pure: the server reads the `<link>` declarations
// through CDP, picks one here, fetches the bytes itself and ships a data URI; the client never loads a site's icon.
import { BLANK_URL } from './browser.tabs'

/** Largest icon (bytes, before base64) the server keeps and sends to the client. */
export const MAX_FAVICON_BYTES = 64 * 1024
/** Most `<link>` declarations read from one page; a page with more is not a favicon list. */
export const MAX_ICON_LINKS = 32
/** Image types a favicon may have, decided by sniffing the bytes (never by Content-Type alone). */
export const FAVICON_MIME = ['image/png', 'image/x-icon', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const
export type FaviconMime = (typeof FAVICON_MIME)[number]

/** One `<link rel=... href=...>` of a page; `href` is already absolute (the DOM resolves it). */
export interface IconLink { rel: string; href: string; sizes?: string; type?: string; media?: string }

const MIN_CRISP_PX = 32 // 16 CSS px at 2x density
const ICON_REL = new Set(['icon'])
const FALLBACK_REL = new Set(['apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'])
const DARK_ONLY = /prefers-color-scheme\s*:\s*dark/i // the page is shown on its own light canvas, so dark-only variants never apply

const relTokens = (rel: string): string[] => rel.toLowerCase().split(/\s+/).filter(Boolean)
const isVector = (l: IconLink): boolean => /^image\/svg\+xml$/i.test(l.type ?? '') || /\.svg(?:[?#]|$)/i.test(l.href) || /^data:image\/svg\+xml/i.test(l.href) || /\bany\b/i.test(l.sizes ?? '')

/** Smallest side declared in `sizes` ("16x16 32x32"), or undefined when none is declared. */
function declaredSide(sizes: string | undefined): number | undefined {
  const sides = [...(sizes ?? '').matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.min(Number(m[1]), Number(m[2])))
  return sides.length ? Math.max(...sides) : undefined
}

/** Lower rank wins: vector, then the smallest size that stays crisp, then undeclared, then the largest too-small one. */
function rank(l: IconLink): number {
  if (isVector(l)) return 0
  const side = declaredSide(l.sizes)
  if (side === undefined) return 1_000_000
  return side >= MIN_CRISP_PX ? 1 + side : 2_000_000 - side
}

const usable = (l: IconLink): boolean => {
  if (DARK_ONLY.test(l.media ?? '')) return false
  return /^(https?:|data:image\/)/i.test(l.href)
}

/**
 * The icon URL to show for a page: `rel=icon` first (apple-touch / mask icons only when the page has no other), best by
 * `rank`; no declaration at all falls back to `<origin>/favicon.ico`. `null` for pages that have no origin (about:blank).
 */
export function pickFavicon(links: readonly IconLink[], pageUrl: string): string | null {
  if (pageUrl === '' || pageUrl === BLANK_URL) return null
  let origin: string
  try {
    const u = new URL(pageUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    origin = u.origin
  } catch {
    return null
  }
  const ok = links.slice(0, MAX_ICON_LINKS).filter((l) => typeof l.href === 'string' && typeof l.rel === 'string' && usable(l))
  const by = (rels: Set<string>) => ok.filter((l) => relTokens(l.rel).some((t) => rels.has(t)))
  const pool = by(ICON_REL).length ? by(ICON_REL) : by(FALLBACK_REL)
  if (pool.length === 0) return `${origin}/favicon.ico`
  return pool.map((l, i) => ({ l, i, r: rank(l) })).sort((a, b) => a.r - b.r || a.i - b.i)[0].l.href
}
