// SSE client for one conversation (RND/11 §4).
//
// Reconnect is manual on purpose: the browser's automatic retry cannot be told which cursor to
// resume from, and a silent duplicate replay would fight the store's dedupe. Here every attempt
// carries `?after=<lastSeq>` (the server treats it like `Last-Event-ID`), and the `id:` line is
// also read as the cursor. EventSource cannot set headers; it needs none: the browser sends the
// HttpOnly `wt_ui` cookie, and the server never reads a token from the query.
import type { ChatEventSource, ChatStream, ChatStreamOptions, ChatStreamStatus } from './chatTypes'
import { CHAT_EVENT_TYPES, CHAT_PATH } from './chatTransport'
import { parseEventFrame } from './chatWire'

/** Reconnect backoff; capped so a long outage keeps retrying without hammering the server. */
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 10_000

export function openChatStream(conversationId: string, opts: ChatStreamOptions): ChatStream {
  const create =
    opts.createSource ?? ((url: string) => new EventSource(url) as unknown as ChatEventSource)
  const handlers = new Map<string, (event: MessageEvent) => void>()
  let source: ChatEventSource | null = null
  let lastSeq = opts.after !== undefined && opts.after > 0 ? opts.after : 0
  let attempts = 0
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const status = (next: ChatStreamStatus): void => {
    if (!closed) opts.onStatus(next)
  }

  const url = (): string => {
    const query: string[] = []
    if (lastSeq > 0) query.push(`after=${lastSeq}`)
    const base = `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/stream`
    return query.length === 0 ? base : `${base}?${query.join('&')}`
  }

  const cleanup = (): void => {
    if (source) {
      for (const [type, handler] of handlers) source.removeEventListener?.(type, handler)
      source.onopen = null
      source.onerror = null
      source.close()
      source = null
    }
    handlers.clear()
  }

  const close = (final: ChatStreamStatus): void => {
    closed = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    cleanup()
    opts.onStatus(final)
  }

  const applyFrame = (type: string, event: MessageEvent): void => {
    const parsed = parseEventFrame(type, event.data ?? '', event.lastEventId ?? '', conversationId)
    if (!parsed) return
    if (parsed.seq <= lastSeq) return // duplicate replay frame
    lastSeq = parsed.seq
    opts.onEvent(parsed)
    // `done` ends the TURN, not the subscription: the next message in this conversation must
    // still stream. The server closes the response only when there is nothing left to stream;
    // that surfaces as onerror, which reconnects at the current cursor.
  }

  const reconnect = (): void => {
    if (closed) return
    cleanup()
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS)
    attempts += 1
    status('reconnecting')
    retryTimer = setTimeout(connect, delay)
  }

  const connect = (): void => {
    if (closed) return
    retryTimer = null
    status(attempts === 0 ? 'connecting' : 'reconnecting')
    let next: ChatEventSource
    try {
      next = create(url())
    } catch {
      reconnect()
      return
    }
    source = next
    next.onopen = () => {
      if (closed) return
      attempts = 0
      status('open')
    }
    next.onerror = () => reconnect()
    for (const type of CHAT_EVENT_TYPES) {
      // Server-sent `error` frames are MessageEvents; transport failures arrive on onerror and
      // carry no data. Splitting on that keeps a failed turn distinct from a dead socket.
      const handler = (event: MessageEvent): void => {
        if (type === 'error' && typeof event?.data !== 'string') {
          reconnect()
          return
        }
        applyFrame(type, event)
      }
      handlers.set(type, handler)
      next.addEventListener(type, handler)
    }
  }

  connect()
  return { close: () => close('closed') }
}
