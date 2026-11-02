// Reports browser-side failures (uncaught errors, unhandled rejections, failed API calls) to the
// server log so they show up in the Output panel next to server events.
//
// The sender must never feed itself: it posts through the ORIGINAL `fetch` (captured before the
// failure hook replaces it), drops a batch whose POST fails, and then stays quiet for a backoff
// window. No path from "could not send logs" back to "log something".
import type { ClientLogInput, LogLevel } from '../../shared/logEntry'
import { TOKEN_HEADER } from '../api'
import { peekToken } from '../transportToken'

/** Server accepts at most 20 entries per request (SPEC-LOG, POST /api/logs/client). */
export const CLIENT_LOG_BATCH_MAX = 20
/** Entries waiting for a send; the oldest are dropped past this. */
export const CLIENT_LOG_QUEUE_MAX = 100
/** Delay that coalesces a burst of errors into one request. */
export const CLIENT_LOG_FLUSH_MS = 2000
/** After a failed POST nothing is sent for this long. */
export const CLIENT_LOG_BACKOFF_MS = 30_000
/** Identical events inside this window are counted once, so a render loop cannot flood the server. */
export const CLIENT_LOG_DEDUPE_MS = 5000
const MESSAGE_MAX = 300
const STACK_MAX = 800
const LOG_ENDPOINT = '/api/logs/client'

export interface ClientLogger {
  log(level: LogLevel, event: string, message: string, data?: Record<string, unknown>): void
  /** Sends what is queued now (also what the timer calls). Resolves after the attempt. */
  flush(): Promise<void>
  dispose(): void
}

export interface ClientLoggerDeps {
  send: (entries: ClientLogInput[]) => Promise<void>
  now?: () => number
}

/** Drops `?key=value` query strings from anything URL-shaped; they can carry tokens. */
export function stripUrlQueries(text: string): string {
  return text.replace(/\?[^\s)'"]*=[^\s)'"]*/g, '')
}

function clip(text: string, max: number): string {
  const clean = stripUrlQueries(text)
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Builds a logger around `send`; split from the browser wiring so it can be driven by tests. */
export function createClientLogger(deps: ClientLoggerDeps): ClientLogger {
  const now = deps.now ?? Date.now
  const queue: ClientLogInput[] = []
  const lastSeen = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let mutedUntil = 0
  let sending = false

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => { timer = null; void flush() }, CLIENT_LOG_FLUSH_MS)
  }

  async function flush(): Promise<void> {
    if (sending || queue.length === 0 || now() < mutedUntil) return
    sending = true
    const batch = queue.splice(0, CLIENT_LOG_BATCH_MAX)
    try {
      await deps.send(batch)
    } catch {
      // Deliberately silent: reporting this failure would be logging about logging.
      mutedUntil = now() + CLIENT_LOG_BACKOFF_MS
    } finally {
      sending = false
    }
    if (queue.length > 0 && now() >= mutedUntil) schedule()
  }

  return {
    log(level, event, message, data) {
      const at = now()
      const key = `${event}\u0000${message}`
      const prev = lastSeen.get(key)
      if (prev !== undefined && at - prev < CLIENT_LOG_DEDUPE_MS) return
      lastSeen.set(key, at)
      if (lastSeen.size > CLIENT_LOG_QUEUE_MAX) lastSeen.delete(lastSeen.keys().next().value as string)
      if (queue.length >= CLIENT_LOG_QUEUE_MAX) queue.shift()
      queue.push({ level, event, message: clip(message, MESSAGE_MAX), ...(data ? { data } : {}) })
      schedule()
    },
    flush,
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

function errorFields(reason: unknown): { message: string; data: Record<string, unknown> } {
  if (reason instanceof Error) {
    return {
      message: `${reason.name}: ${reason.message}`,
      data: reason.stack ? { stack: clip(reason.stack, STACK_MAX) } : {},
    }
  }
  return { message: typeof reason === 'string' ? reason : 'Non-error value thrown', data: {} }
}

/**
 * Installs the window error handlers and the failed-API-call hook. Returns the uninstaller.
 * Only the path of a failing request is recorded (never the query, body or headers).
 */
export function installClientLogger(): () => void {
  const realFetch = window.fetch.bind(window)
  const logger = createClientLogger({
    send: async (entries) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const token = peekToken()
      if (token !== '') headers[TOKEN_HEADER] = token
      const res = await realFetch(LOG_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ entries }) })
      if (!res.ok) throw new Error(`POST ${LOG_ENDPOINT} -> ${res.status}`)
    },
  })

  const onError = (e: ErrorEvent): void => {
    const { message, data } = errorFields(e.error ?? e.message)
    logger.log('error', 'client.error', message, { ...data, source: e.filename ? stripUrlQueries(e.filename) : undefined, line: e.lineno })
  }
  const onRejection = (e: PromiseRejectionEvent): void => {
    const { message, data } = errorFields(e.reason)
    logger.log('error', 'client.unhandledrejection', message, data)
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  const reportFetch = (input: RequestInfo | URL, init: RequestInit | undefined, outcome: string, level: LogLevel): void => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(raw, window.location.href).pathname
    if (path === LOG_ENDPOINT) return
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    logger.log(level, 'client.fetch.fail', `${method} ${path} ${outcome}`, { method, path })
  }
  window.fetch = async (input, init) => {
    try {
      const res = await realFetch(input, init)
      if (res.status >= 500) reportFetch(input, init, String(res.status), 'warn')
      return res
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) reportFetch(input, init, 'network error', 'error')
      throw err
    }
  }

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.fetch = realFetch
    logger.dispose()
  }
}
