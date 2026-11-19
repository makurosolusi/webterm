// Pure helpers of the cookie import dialog: format sniffing, error classification, relative expiry. No cookie value is kept.
import type { CookieFormat } from '../../shared/browser.contract'

/** File extensions the picker and the drop zone accept. */
export const COOKIE_FILE_EXTENSIONS = ['.json', '.txt', '.cookies'] as const
const SNIFF_LINES = 60 // enough to see a Netscape row after the header comments
const NETSCAPE_MIN_FIELDS = 6
const HTTP_ONLY_PREFIX = '#HttpOnly_'

/** True when the file name has an accepted extension. */
export const hasCookieExtension = (name: string): boolean => COOKIE_FILE_EXTENSIONS.some((x) => name.toLowerCase().endsWith(x))

/** Guess the format from the first characters / rows; null = ambiguous (the dialog then asks). */
export function detectCookieFormat(text: string): CookieFormat | null {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'storageState'
  for (const raw of t.split(/\r?\n/, SNIFF_LINES)) {
    const line = raw.startsWith(HTTP_ONLY_PREFIX) ? raw.slice(HTTP_ONLY_PREFIX.length) : raw
    if (line.trim() === '' || line.startsWith('#')) continue
    return line.split('\t').length >= NETSCAPE_MIN_FIELDS ? 'netscape' : null
  }
  return null
}

export type CookieErrorKind = 'invalid' | 'empty' | 'too_large' | 'wrong_type' | 'unreadable' | 'expired' | 'network' | 'unknown' | 'disabled'

const BY_CODE: Record<string, CookieErrorKind> = {
  bad_request: 'invalid', cookie_import_invalid: 'invalid', cookie_import_empty: 'empty', payload_too_large: 'too_large',
  not_found: 'expired', disabled: 'disabled', cookie_import_disabled: 'disabled',
}

/** Map a thrown API error (server `code`, HTTP status, or a failed fetch) to a kind with specific copy. */
export function classifyCookieError(e: unknown): CookieErrorKind {
  if (e instanceof TypeError) return 'network'
  const o = typeof e === 'object' && e !== null ? (e as { code?: unknown; status?: unknown }) : {}
  if (o.status === 413) return 'too_large'
  return (typeof o.code === 'string' ? BY_CODE[o.code] : undefined) ?? 'unknown'
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]]

/** "in 6 days" style text for a future timestamp (ms); "soon" under a minute, "now" when past. */
export function relativeExpiry(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const diff = at - now
  if (diff <= 0) return 'now'
  const unit = UNITS.find(([, ms]) => diff >= ms)
  if (!unit) return 'soon'
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(Math.round(diff / unit[1]), unit[0])
}
