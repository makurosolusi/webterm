// SSE client for one conversation (RND/11 §4), generic over the feed so the agent chat node
// (PLAN/AGENT-CHAT.md D10) reuses the same cursor + backoff instead of a copy.
//
// Reconnect is manual on purpose: the browser's automatic retry cannot be told which cursor to
// resume from, and a silent duplicate replay would fight the store's dedupe. Here every attempt
// carries `?after=<lastSeq>` (the server treats it like `Last-Event-ID`), and the `id:` line is
// also read as the cursor. EventSource cannot set headers; it needs none: the browser sends the
// HttpOnly `wt_ui` cookie, and the server never reads a token from the query.
// The stream rides the shared WebSocket (`openEventStream`), not an HTTP connection of its own.
import type { ChatEvent, ChatEventSource, ChatStream, ChatStreamOptions, ChatStreamStatus } from './chatTypes'
import { CHAT_EVENT_TYPES, CHAT_PATH } from './chatTransport'
import { parseEventFrame } from './chatWire'
import { afterPageLoad } from '../pageLoad'
import { scheduleStreamRetry } from '../ws.connection'
import { openEventStream } from '../ws'

/** What differs between SSE feeds: the URL, the `event:` names and the frame parser. */
export interface SseFeed<E extends { seq: number }> {
  path: string
  eventTypes: readonly string[]
  parse: (type: string, data: string, lastEventId: string) => E | null
  /** A frame at or below the cursor that still applies (state the server re-sends on connect). */
  reapply?: (event: E) => boolean
}

export type SseStreamOptions<E> = Omit<ChatStreamOptions, 'onEvent'> & { onEvent: (event: E) => void }

export function openSseStream<E extends { seq: number }>(feed: SseFeed<E>, opts: SseStreamOptions<E>): ChatStream {
  const create =
    opts.createSource ?? ((url: string) => openEventStream(url) as unknown as ChatEventSource)
  const handlers = new Map<string, (event: MessageEvent) => void>()
  let source: ChatEventSource | null = null
  let lastSeq = opts.after !== undefined && opts.after > 0 ? opts.after : 0
  let attempts = 0
  let closed = false
  let cancelRetry = (): void => {}
  let cancelStart = (): void => {}

  const status = (next: ChatStreamStatus): void => {
    if (!closed) opts.onStatus(next)
  }

  const url = (): string => {
    const query: string[] = []
    if (lastSeq > 0) query.push(`after=${lastSeq}`)
    return query.length === 0 ? feed.path : `${feed.path}?${query.join('&')}`
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
    cancelStart()
    cancelRetry()
    cleanup()
    opts.onStatus(final)
  }

  const applyFrame = (type: string, event: MessageEvent): void => {
    const parsed = feed.parse(type, event.data ?? '', event.lastEventId ?? '')
    if (!parsed) return
    if (parsed.seq <= lastSeq) {
      // Duplicate replay frame, unless the feed says it is re-sent state (never moves the cursor back).
      if (feed.reapply?.(parsed)) opts.onEvent(parsed)
      return
    }
    lastSeq = parsed.seq
    opts.onEvent(parsed)
    // `done` ends the TURN, not the subscription: the next message in this conversation must
    // still stream. The server closes the response only when there is nothing left to stream;
    // that surfaces as onerror, which reconnects at the current cursor.
  }

  const reconnect = (): void => {
    if (closed) return
    cleanup()
    cancelRetry()
    // Jittered backoff, and no timer at all while the shared socket says the server is unreachable.
    cancelRetry = scheduleStreamRetry(attempts, connect)
    attempts += 1
    status('reconnecting')
  }

  const connect = (): void => {
    if (closed) return
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
    // `onerror` is the handler for EVERY `error` event, and the server names a failed turn's frame
    // `event: error` too. Reconnecting on that frame dropped it unapplied and replayed it on every
    // reconnect: an endless "Reconnecting…" and a failed reply that never showed why.
    next.onerror = (event) => {
      if (typeof (event as MessageEvent | undefined)?.data === 'string') return
      reconnect()
    }
    for (const type of feed.eventTypes) {
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

  cancelStart = afterPageLoad(connect)
  return { close: () => close('closed') }
}

export function openChatStream(conversationId: string, opts: ChatStreamOptions): ChatStream {
  return openSseStream<ChatEvent>({
    path: `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/stream`,
    eventTypes: CHAT_EVENT_TYPES,
    parse: (type, data, lastEventId) => parseEventFrame(type, data, lastEventId, conversationId),
  }, opts)
}
