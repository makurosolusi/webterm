// POST /api/logs/client: bounded intake of browser-side log entries. Untrusted input, so: body cap,
// entry-count cap, per-process rate limit, fixed channel/source, and the normal redaction gate.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLogLevel, type LogLevel } from '../../shared/logEntry'
import { readCappedRequestBody } from '../cappedRequestBody'
import { recordEntry } from './logger'
import { safeText } from './logSanitize'

export const CLIENT_BODY_MAX_BYTES = 32 * 1024
export const CLIENT_MAX_ENTRIES = 20
export const CLIENT_RATE_MAX_ENTRIES = 200
export const CLIENT_RATE_WINDOW_MS = 60_000
const CLIENT_MESSAGE_CHARS = 1000
const CLIENT_CHANNEL = 'client'
const DEFAULT_CLIENT_EVENT = 'client.log'

/** Fixed-window counter: `take(n)` is false once more than `max` units were taken in the window. */
export function createWindowLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  let start = 0
  let used = 0
  return {
    take(units: number): boolean {
      const t = now()
      if (t - start >= windowMs) { start = t; used = 0 }
      if (used + units > max) return false
      used += units
      return true
    },
    retryAfterSeconds(): number { return Math.max(1, Math.ceil((start + windowMs - now()) / 1000)) },
  }
}

const limiter = createWindowLimiter(CLIENT_RATE_MAX_ENTRIES, CLIENT_RATE_WINDOW_MS)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

export async function handleClientLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const read = await readCappedRequestBody(req, CLIENT_BODY_MAX_BYTES)
  if (!read.ok) return reply(res, read.reason === 'too_large' ? 413 : 400, { error: read.reason === 'too_large' ? 'payload_too_large' : 'body_read_failed' })
  let parsed: unknown
  try { parsed = JSON.parse(read.body) } catch { return reply(res, 400, { error: 'bad_json' }) }
  const entries = isRecord(parsed) ? parsed.entries : undefined
  if (!Array.isArray(entries) || entries.length === 0) return reply(res, 400, { error: 'invalid_body' })
  if (entries.length > CLIENT_MAX_ENTRIES) return reply(res, 400, { error: 'too_many_entries' })
  if (!entries.every((e) => isRecord(e) && isLogLevel(e.level) && typeof e.message === 'string')) return reply(res, 400, { error: 'invalid_entry' })
  if (!limiter.take(entries.length)) return reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(limiter.retryAfterSeconds()) })
  for (const e of entries as Array<Record<string, unknown>>) {
    const event = typeof e.event === 'string' ? safeText(e.event, 64) : ''
    recordEntry({
      level: e.level as LogLevel,
      source: 'client',
      channel: CLIENT_CHANNEL,
      event: event || DEFAULT_CLIENT_EVENT,
      message: safeText(e.message, CLIENT_MESSAGE_CHARS),
      data: isRecord(e.data) ? e.data : undefined,
    })
  }
  reply(res, 202, { accepted: entries.length })
}
