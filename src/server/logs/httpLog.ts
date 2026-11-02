// Request-scoped logging for the /api router: `http.request` (debug) and `http.error` (5xx / exception).
// Only method, templated path, status and duration are recorded: never the query string (it can carry
// the token), headers or bodies.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOGS_PATH } from './logApi'
import { createLogger } from './logger'

const log = createLogger('api')
const REQUEST_ID_CHARS = 8
const SERVER_ERROR = 500
/** Opaque-looking segment (has a digit, 8+ id characters) becomes `:id` so log lines stay groupable. */
const ID_SEGMENT = /^(?=.*\d)[\w-]{8,}$/

/** `/api/workspaces/3f2a9c1e-…` -> `/api/workspaces/:id`. */
export function pathTemplate(pathname: string): string {
  return pathname.split('/').map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg)).join('/')
}

export interface RequestLog {
  /** Record an exception raised by a route handler. */
  fail(err: unknown): void
}

/** Start logging one /api request; the log API itself is skipped so reading logs never creates logs. */
export function startRequestLog(req: IncomingMessage, res: ServerResponse): RequestLog {
  const method = req.method || 'GET'
  const pathname = new URL(req.url || '/', 'http://x').pathname
  if (pathname === LOGS_PATH || pathname.startsWith(`${LOGS_PATH}/`)) return { fail: () => {} }
  const ids = { requestId: randomUUID().slice(0, REQUEST_ID_CHARS) }
  const path = pathTemplate(pathname)
  const started = Date.now()
  let failed = false
  res.on('close', () => {
    const status = res.statusCode
    const ms = Date.now() - started
    if (status >= SERVER_ERROR && !failed) log.warn('http.error', `${method} ${path} -> ${status}`, { ids, method, path, status, ms })
    else log.debug('http.request', `${method} ${path} -> ${status}`, { ids, method, path, status, ms, aborted: !res.writableFinished })
  })
  return {
    fail(err) {
      failed = true
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      log.error('http.error', `${method} ${path} failed: ${detail}`, { ids, method, path })
    },
  }
}
