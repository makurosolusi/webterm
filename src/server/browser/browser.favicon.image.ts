// Favicon bytes -> a safe data URI, or nothing. Fail-closed: the type comes from the bytes (magic numbers), never from
// the response's Content-Type; an SVG with anything active or external in it is refused rather than repaired.
import { FAVICON_MIME, MAX_FAVICON_BYTES } from '../../shared/browser.favicon'
import type { FaviconMime } from '../../shared/browser.favicon'

const startsWith = (b: Uint8Array, sig: number[]): boolean => sig.every((v, i) => b[i] === v)
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))
const SVG_HEAD_BYTES = 1024 // the `<svg` tag must show up within the first KiB (after BOM, prolog, comments)
const SVG_START = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i

/** Image type of the bytes, or null (unknown, an HTML error page, an executable...). */
export function sniffImage(b: Uint8Array): FaviconMime | null {
  if (b.length < 4) return null
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp'
  if (startsWith(b, [0, 0, 1, 0])) return 'image/x-icon'
  return SVG_START.test(new TextDecoder('utf-8').decode(b.subarray(0, SVG_HEAD_BYTES))) ? 'image/svg+xml' : null
}

const ACTIVE_ELEMENT = /<\s*(?:script|foreignObject|iframe|object|embed|animate|animateTransform|set|handler|listener)\b/i
const EVENT_ATTR = /\son[a-z]+\s*=/i
const EXTERNAL_REF = /href\s*=\s*(?!["']?\s*#)/i // any href that is not an in-document `#id`
const DANGEROUS_TEXT = /<!\s*(?:DOCTYPE|ENTITY)|<!\[CDATA\[|javascript:|@import|url\(\s*(?!["']?\s*#)/i

/** True when the SVG text carries nothing active or external: no script, handlers, outside references, entities. */
export function isSafeSvg(text: string): boolean {
  return !ACTIVE_ELEMENT.test(text) && !EVENT_ATTR.test(text) && !EXTERNAL_REF.test(text) && !DANGEROUS_TEXT.test(text)
}

/** `data:<mime>;base64,...` for bytes that are a small, recognised, safe image; null otherwise. */
export function faviconDataUri(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return null
  const mime = sniffImage(bytes)
  if (!mime || !FAVICON_MIME.includes(mime)) return null
  if (mime === 'image/svg+xml' && !isSafeSvg(new TextDecoder('utf-8').decode(bytes))) return null
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Bytes of an inline `data:` icon (`<link href="data:image/svg+xml,...">`, common in dev apps); null when malformed or over the cap. */
export function decodeDataUrl(url: string): Uint8Array | null {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(url)
  if (!m || url.length > MAX_FAVICON_BYTES * 2) return null
  try {
    return m[1].toLowerCase().endsWith(';base64') ? new Uint8Array(Buffer.from(m[2], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[2]))
  } catch {
    return null // malformed percent-escape: not an icon
  }
}
