// Server-sent event streams over the shared socket (ws.ts), in place of one EventSource each.
// HTTP/1.1 gives a host 6 connections shared by every tab; long-lived EventSources (logs, events,
// Central chat, each Agent Chat node, Activity) used them all up and every further fetch queued
// forever. A WebSocket is outside that limit, so one socket carries them all (VS Code web does the
// same: everything multiplexed over its one remote socket).
//
// `WsEventSource` keeps the EventSource surface the consumers use (onopen/onmessage/onerror, named
// events via addEventListener, close, readyState). It never reconnects by itself: like a dropped
// EventSource it reports `error`, and every consumer already closes and reopens on its own backoff
// with its own cursor (`?afterSeq=` / `?after=`).
import type { ClientMsg, ServerMsg } from '../shared/protocol'

/** EventSource readyState values. */
export const STREAM_CONNECTING = 0
export const STREAM_OPEN = 1
export const STREAM_CLOSED = 2

type StreamFrame = Extract<ServerMsg, { t: 'sse.open' | 'sse.ev' | 'sse.end' }>
/** Sends a frame when the socket is open; false = not sent (the stream waits for the next open). */
type SendIfOpen = (msg: ClientMsg) => boolean

const streams = new Map<string, WsEventSource>()
let nextId = 0

export class WsEventSource extends EventTarget {
  readonly id = `sse-${++nextId}`
  readyState: number = STREAM_CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  /** The server holds a subscription for this id (a sub went out and no end came back). */
  subscribed = false

  constructor(readonly url: string, private readonly sendIfOpen: SendIfOpen) { super() }

  close(): void {
    this.readyState = STREAM_CLOSED
    if (streams.get(this.id) !== this) return
    streams.delete(this.id)
    if (this.subscribed) this.sendIfOpen({ t: 'sse.unsub', id: this.id })
    this.subscribed = false
  }

  /** Listeners, then the `on<type>` handler, as an EventSource delivers it. */
  emit(event: Event): void {
    this.dispatchEvent(event)
    if (event.type === 'open') this.onopen?.(event)
    else if (event.type === 'message') this.onmessage?.(event as MessageEvent)
    else if (event.type === 'error') this.onerror?.(event)
  }

  /** The stream is over on the server side: `readyState` as EventSource leaves it, then `error`. */
  fail(readyState: number): void {
    streams.delete(this.id)
    this.subscribed = false
    this.readyState = readyState
    this.emit(new Event('error'))
  }

  subscribe(): void {
    if (!this.subscribed) this.subscribed = this.sendIfOpen({ t: 'sse.sub', id: this.id, url: this.url })
  }
}

/** Register a stream; it subscribes now when the socket is open, else on the next open. */
export function addStream(url: string, sendIfOpen: SendIfOpen): WsEventSource {
  const s = new WsEventSource(url, sendIfOpen)
  streams.set(s.id, s)
  s.subscribe()
  return s
}

/** Socket opened: subscribe every stream still waiting. */
export function streamsSocketOpened(): void {
  for (const s of streams.values()) s.subscribe()
}

/** Socket gone: every subscription died with it. Reported like a dropped EventSource (CONNECTING + error). */
export function streamsSocketClosed(): void {
  for (const s of [...streams.values()]) if (s.subscribed) s.fail(STREAM_CONNECTING)
}

/** Deliver a stream frame; false = not a stream frame. */
export function dispatchStreamFrame(msg: ServerMsg): msg is StreamFrame {
  if (msg.t !== 'sse.open' && msg.t !== 'sse.ev' && msg.t !== 'sse.end') return false
  const s = streams.get(msg.id)
  if (!s) return true
  if (msg.t === 'sse.open') {
    s.readyState = STREAM_OPEN
    s.emit(new Event('open'))
  } else if (msg.t === 'sse.ev') {
    s.emit(new MessageEvent(msg.event, { data: msg.data, lastEventId: msg.lastId }))
  } else {
    // A 200 that ended is a stream EventSource would retry; any other status is a refusal it gives up on.
    s.fail(msg.status === 200 ? STREAM_CONNECTING : STREAM_CLOSED)
  }
  return true
}

/** Test teardown: forget every stream. */
export function __resetStreamsForTests(): void { streams.clear() }
