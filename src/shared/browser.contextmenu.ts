// What the page under a right click holds, as the canvas browser reports it to the client for its own context menu.
// The page is untrusted: `sanitizeContext` is the only way a hit-test result becomes a message (http/https only, capped).
export const CTX_HREF_MAX = 2048
export const CTX_TEXT_MAX = 120
const CTX_RAW_MAX = 16_384

export interface ContextInfo {
  /** Link under the pointer (http/https only). */
  link?: { href: string; text: string }
  /** Image under the pointer (http/https only; `data:` is never reported). */
  image?: string
  /** The page has selected text (the text itself is read on demand by Copy, never sent here). */
  selection: boolean
  /** The pointer is on an editable field. */
  editable: boolean
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The url when it is an absolute http(s) address within the cap; otherwise undefined. */
export function webUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > CTX_HREF_MAX) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined // not a URL: the field is dropped, the menu still opens
  }
}

/** Hit-test result of a page (JSON text or object) -> menu info; null = unusable (the menu is not shown). */
export function sanitizeContext(raw: unknown): ContextInfo | null {
  let v = raw
  if (typeof raw === 'string') {
    if (raw.length > CTX_RAW_MAX) return null
    try { v = JSON.parse(raw) } catch { return null } // a page that returns garbage gets no menu
  }
  if (!obj(v)) return null
  const link = obj(v.link) ? v.link : undefined
  const href = webUrl(link?.href)
  const text = typeof link?.text === 'string' ? link.text.replace(/\s+/g, ' ').trim().slice(0, CTX_TEXT_MAX) : ''
  const image = webUrl(v.image)
  return { ...(href ? { link: { href, text } } : {}), ...(image ? { image } : {}), selection: v.selection === true, editable: v.editable === true }
}
