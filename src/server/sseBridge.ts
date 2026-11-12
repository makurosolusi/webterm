// Server-sent event streams carried over the terminal WebSocket (`sse.sub` / `sse.unsub`), so the
// browser holds no long-lived HTTP connection (HTTP/1.1: 6 per host, shared by every tab).
//
// The existing SSE route handlers run unchanged: each subscription is an in-memory GET request,
// built from the WebSocket upgrade request's own headers, through the SAME dispatcher and gate as
// HTTP (`routeApp` in index.ts). The response is a sink that parses the SSE text it is given and
// forwards each event as `sse.ev`; `sse.end` carries the HTTP status when it ends or is refused.
// Unsubscribe / socket close fire `close` on the request and the response, which is how every
// handler already releases its subscriber when a browser goes away.
import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { ServerMsg } from '../shared/protocol'
import { createLogger } from './logs'

/** The SSE routes the client streams over the socket; anything else is refused before it runs. */
export const STREAM_PATH_RE = /^\/api\/(?:logs\/stream|events\/stream|central\/conversations\/[^/]+\/stream|agent-chat\/[^/]+\/stream)$/
/** Concurrent streams per socket (one per Agent Chat node plus a few app-wide ones). */
export const MAX_STREAMS_PER_SOCKET = 64
const MAX_URL_CHARS = 2048
const MAX_ID_CHARS = 64
/** Statuses for refusals the bridge makes itself (the route never ran). */
export const STREAM_NOT_ALLOWED = 404
export const STREAM_TOO_MANY = 429
/** A route answered 200 but not text/event-stream. */
export const STREAM_NOT_SSE = 415

/** Runs one request exactly like the HTTP server does (gate + /api dispatcher). */
export type StreamDispatch = (req: IncomingMessage, res: ServerResponse) => void

export interface StreamBridge {
  sub(id: unknown, url: unknown): void
  unsub(id: unknown): void
  /** The socket closed: end every stream (handlers clean up). */
  closeAll(): void
}

/** What of the upgrade request a stream request inherits: its identity, nothing else. */
export type UpgradeIdentity = Pick<IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string } }

const log = createLogger('ws')

/** Headers of the upgrade minus the WebSocket handshake ones: the credential and origin stay identical. */
function streamHeaders(upgrade: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [k, v] of Object.entries(upgrade)) {
    if (k === 'upgrade' || k === 'connection' || k.startsWith('sec-websocket-')) continue
    out[k] = v
  }
  out.accept = 'text/event-stream'
  return out
}

/** Normalized `path?query` of an allowed stream url, or null. Dot segments are resolved before the check. */
export function streamTarget(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_URL_CHARS || !url.startsWith('/api/')) return null
  let parsed: URL
  try { parsed = new URL(url, 'http://x') } catch { return null }
  if (parsed.host !== 'x' || !STREAM_PATH_RE.test(parsed.pathname)) return null
  return parsed.pathname + parsed.search
}

/** The ServerResponse surface the SSE handlers use, writing into `sse.*` frames instead of a socket. */
class StreamSink extends EventEmitter {
  statusCode = 200
  headersSent = false
  writableEnded = false
  writableFinished = false
  destroyed = false
  private readonly headers = new Map<string, number | string | readonly string[]>()
  private sse = false
  private buf = ''
  private event = ''
  private data: string[] = []
  private lastId = ''

  constructor(
    private readonly id: string,
    private readonly send: (m: ServerMsg) => void,
    private readonly buffered: () => number,
    private readonly req: EventEmitter,
    private readonly onShut: () => void,
  ) { super() }

  /** The socket's send queue: the handlers' slow-reader guard reads it like a socket's. */
  get writableLength(): number { return this.buffered() }

  setHeader(name: string, value: number | string | readonly string[]): this { this.headers.set(name.toLowerCase(), value); return this }
  getHeader(name: string): number | string | readonly string[] | undefined { return this.headers.get(name.toLowerCase()) }
  hasHeader(name: string): boolean { return this.headers.has(name.toLowerCase()) }
  removeHeader(name: string): void { this.headers.delete(name.toLowerCase()) }
  getHeaders(): Record<string, number | string | readonly string[]> { return Object.fromEntries(this.headers) }

  writeHead(status: number, a?: unknown, b?: unknown): this {
    this.statusCode = status
    const hs = typeof a === 'string' ? b : a
    if (hs && typeof hs === 'object') for (const [k, v] of Object.entries(hs)) this.setHeader(k, v as string)
    return this
  }

  flushHeaders(): void { this.commit() }

  write(chunk: unknown, enc?: unknown, cb?: unknown): boolean {
    if (this.destroyed || this.writableEnded) return false
    this.commit()
    if (this.sse) this.parse(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    const done = typeof enc === 'function' ? enc : cb
    if (typeof done === 'function') queueMicrotask(() => (done as () => void)())
    return true
  }

  end(chunk?: unknown): this {
    if (this.writableEnded || this.destroyed) return this
    if (chunk !== undefined && typeof chunk !== 'function') this.write(chunk)
    this.commit()
    this.writableEnded = this.writableFinished = true
    if (this.sse) this.send({ t: 'sse.end', id: this.id, status: this.statusCode })
    this.emit('finish')
    this.shut()
    return this
  }

  /** Unsubscribe / socket close: the browser went away. */
  destroy(): this { this.shut(); return this }

  /** Headers are final: open the stream, or refuse anything that is not 200 text/event-stream. */
  private commit(): void {
    if (this.headersSent) return
    this.headersSent = true
    const type = String(this.getHeader('content-type') ?? '')
    this.sse = this.statusCode === 200 && /^text\/event-stream\b/i.test(type)
    if (this.sse) { this.send({ t: 'sse.open', id: this.id }); return }
    this.send({ t: 'sse.end', id: this.id, status: this.statusCode === 200 ? STREAM_NOT_SSE : this.statusCode })
    // ponytail: a refusal body (JSON error) is not forwarded; the status is what the clients act on.
    queueMicrotask(() => this.shut())
  }

  private shut(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.onShut()
    this.emit('close')
    this.req.emit('close')
  }

  // ponytail: a CRLF split across two writes reads as an extra blank line; handlers write whole frames.
  private parse(text: string): void {
    const lines = (this.buf + text).split(/\r\n|\r|\n/)
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') { this.dispatch(); continue }
      if (line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      let value = i < 0 ? '' : line.slice(i + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') this.event = value
      else if (field === 'data') this.data.push(value)
      else if (field === 'id' && !value.includes('\0')) this.lastId = value
    }
  }

  private dispatch(): void {
    if (this.data.length > 0) this.send({ t: 'sse.ev', id: this.id, event: this.event || 'message', data: this.data.join('\n'), lastId: this.lastId })
    this.event = ''
    this.data = []
  }
}

export function createStreamBridge(
  upgrade: UpgradeIdentity,
  send: (m: ServerMsg) => void,
  dispatch: StreamDispatch,
  buffered: () => number,
): StreamBridge {
  const sinks = new Map<string, StreamSink>()
  const validId = (id: unknown): id is string => typeof id === 'string' && id !== '' && id.length <= MAX_ID_CHARS

  return {
    sub(id, url) {
      if (!validId(id)) return
      sinks.get(id)?.destroy()
      const target = streamTarget(url)
      // Never log the url: a query could carry a pasted token.
      if (!target) { send({ t: 'sse.end', id, status: STREAM_NOT_ALLOWED }); return }
      if (sinks.size >= MAX_STREAMS_PER_SOCKET) { send({ t: 'sse.end', id, status: STREAM_TOO_MANY }); return }
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url: target,
        headers: streamHeaders(upgrade.headers),
        socket: { remoteAddress: upgrade.socket?.remoteAddress },
      })
      const sink: StreamSink = new StreamSink(id, send, buffered, req, () => { if (sinks.get(id) === sink) sinks.delete(id) })
      sinks.set(id, sink)
      try {
        dispatch(req as unknown as IncomingMessage, sink as unknown as ServerResponse)
      } catch (err) {
        log.error('ws.stream_failed', 'Stream subscription failed', { error: err instanceof Error ? err.message : String(err) })
        if (!sink.headersSent) sink.statusCode = 500
        sink.end()
      }
    },
    unsub(id) {
      if (validId(id)) sinks.get(id)?.destroy()
    },
    closeAll() {
      for (const s of [...sinks.values()]) s.destroy()
    },
  }
}
