// Single redaction gate for everything that enters the log: message, event, ids and data all pass
// through here, so no caller can forget it. Never throws: a value that cannot be made safe is replaced.
import { REDACTED, redactSecrets, redactValue } from '../redactSecrets'
import type { LogEntry } from '../../shared/logEntry'

export const MAX_MESSAGE_CHARS = 2000
export const MAX_EVENT_CHARS = 64
export const MAX_ID_CHARS = 128
export const MAX_DATA_CHARS = 4000
const MAX_DEPTH = 4
const MAX_ITEMS = 40
const MAX_STRING_CHARS = 500

/** Broader than redactSecrets' exact-name match: `botToken`, `x-api-key`, `sessionCookie` are masked too. */
const SECRET_FIELD = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Redacted, length-capped text. */
export function safeText(value: unknown, max: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : String(value)
  } catch {
    text = '[unprintable]'
  }
  return clip(redactSecrets(text), max)
}

/** Reduce an arbitrary value to plain JSON-safe data: cycles, Errors, bigint, functions, depth, size. */
function plain(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return clip(value, MAX_STRING_CHARS)
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Error) return { name: value.name, message: clip(value.message, MAX_STRING_CHARS) }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const obj = value as object
  if (seen.has(obj)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[depth]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.slice(0, MAX_ITEMS).map((item) => plain(item, depth + 1, seen) ?? null)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(obj).slice(0, MAX_ITEMS)) {
      out[key] = SECRET_FIELD.test(key) ? REDACTED : plain(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

/** Sanitize the structured fields of an entry; drops them (with a marker) rather than throwing. */
export function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  try {
    const cleaned = redactValue(plain(data, 0, new WeakSet())) as Record<string, unknown>
    if (Object.keys(cleaned).length === 0) return undefined
    const size = JSON.stringify(cleaned).length
    if (size > MAX_DATA_CHARS) return { truncated: true, preview: clip(JSON.stringify(cleaned), MAX_DATA_CHARS / 4) }
    return cleaned
  } catch {
    return { dataDropped: true }
  }
}

/** Sanitize the opaque id bag; non-string and empty ids are dropped. */
export function sanitizeIds(ids: LogEntry['ids']): LogEntry['ids'] {
  if (!ids || typeof ids !== 'object') return undefined
  const out: NonNullable<LogEntry['ids']> = {}
  for (const key of ['workspaceId', 'profileId', 'nodeId', 'sessionId', 'requestId'] as const) {
    const id = ids[key]
    if (typeof id === 'string' && id !== '') out[key] = safeText(id, MAX_ID_CHARS)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi

/** `scheme://host/path` of a URL: no query, fragment or userinfo. Unparseable input falls back to the text before `?`/`#`. */
export function stripUrlQuery(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return raw.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//')
  }
}

/** Free text made safe to hand to an agent: every URL loses its query/fragment, secrets are masked, length is capped. */
export function scrubText(value: unknown, max: number): string {
  return safeText(safeText(value, max * 4).replace(URL_IN_TEXT, (u) => stripUrlQuery(u)), max)
}

/** Deep copy of `value` with `scrubText` applied to every string and header-like keys removed. */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value, MAX_STRING_CHARS)
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => scrubDeep(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) if (!/headers?$/i.test(k)) out[k] = scrubDeep(v, depth + 1)
  return out
}
