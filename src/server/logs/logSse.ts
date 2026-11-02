// SSE stream of log entries: `id:` = seq, event `log`. Resumes from Last-Event-ID / ?afterSeq, sends a
// heartbeat comment, and always releases its bus subscriber when the client goes away.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { firstHeader } from '../httpHeaders'
import type { LogEntry } from '../../shared/logEntry'
import { logBus } from './logBus'

export const HEARTBEAT_MS = 15_000
const RETRY_MS = 3000
/** A reader this far behind is cut off; it reconnects with Last-Event-ID and replays from the buffer. */
const MAX_PENDING_BYTES = 1024 * 1024

const frame = (entry: LogEntry): string => `id: ${entry.seq}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`

/** Cursor from Last-Event-ID (wins) or ?afterSeq; undefined = live only, null = malformed. */
function readCursor(req: IncomingMessage, url: URL): number | undefined | null {
  const raw = firstHeader(req.headers['last-event-id']) ?? url.searchParams.get('afterSeq') ?? undefined
  if (raw === undefined || raw === '') return undefined
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null
}

export function handleLogStream(req: IncomingMessage, res: ServerResponse, url: URL, heartbeatMs = HEARTBEAT_MS): void {
  const cursor = readCursor(req, url)
  if (cursor === null) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'invalid_cursor' }))
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()
  res.write(`retry: ${RETRY_MS}\n\n`)

  let closed = false
  let unsubscribe = (): void => {}
  const heartbeat = setInterval(() => { if (!closed) res.write(': hb\n\n') }, heartbeatMs)
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  const send = (entry: LogEntry): void => {
    if (closed || res.writableEnded) return
    res.write(frame(entry))
    if (res.writableLength > MAX_PENDING_BYTES) { cleanup(); res.end() }
  }
  res.on('close', cleanup)
  req.on('close', cleanup)

  // Replay and subscribe in one synchronous turn: no entry can land between them.
  if (cursor !== undefined) for (const entry of logBus.query({ afterSeq: cursor })) send(entry)
  if (!closed) unsubscribe = logBus.subscribe(send)
}
