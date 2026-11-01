// Per-conversation SSE fan-out for central chat (RND/08 §7, RND/13 §4 C1).
// Subscribers replay `central_event` from `Last-Event-ID` before receiving live
// frames; a publish that would leave a gap asks the replay provider to fill it,
// so a reconnect never loses an event between the DB append and the stream.
// Transport-free: the HTTP writer lives in `centralChatApi.ts`.

/** Minimal shape of one persisted `central_event` row. */
export interface StreamEvent {
  conversationId?: string
  seq: number
  type: string
  turnId?: string | null
  messageId?: string | null
  payload?: unknown
  createdAt?: number
}

export type StreamFrame =
  | { kind: 'event'; id: number; event: string; data: unknown }
  | { kind: 'heartbeat' }

export type StreamSink = (frame: StreamFrame) => void

/** Reads events strictly after `afterSeq`, ascending. */
export type StreamReplay = (conversationId: string, afterSeq: number) => StreamEvent[]

export interface StreamHubOptions {
  replay?: StreamReplay
  heartbeatMs?: number
}

export const DEFAULT_HEARTBEAT_MS = 15_000

interface Subscriber {
  conversationId: string
  lastSeq: number
  sink: StreamSink
  timer: ReturnType<typeof setInterval> | null
  active: boolean
}

function toFrame(event: StreamEvent): StreamFrame {
  return { kind: 'event', id: event.seq, event: event.type, data: event }
}

/** Stable SSE text for one frame; heartbeats are comments so they never reach `onmessage`. */
export function formatSseFrame(frame: StreamFrame): string {
  if (frame.kind === 'heartbeat') return ': heartbeat\n\n'
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
}

export class StreamHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly replay: StreamReplay
  private readonly heartbeatMs: number

  constructor(options: StreamHubOptions = {}) {
    this.replay = options.replay ?? (() => [])
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  }

  /** Replays history, then leaves the sink subscribed until the returned disposer runs. */
  subscribe(conversationId: string, afterSeq: number, sink: StreamSink): () => void {
    const from = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.trunc(afterSeq) : 0
    const sub: Subscriber = { conversationId, lastSeq: from, sink, timer: null, active: true }
    const set = this.subscribers.get(conversationId) ?? new Set<Subscriber>()
    this.subscribers.set(conversationId, set)
    // Register BEFORE replay: publish() is synchronous, so a replay that throws still
    // leaves a usable live channel (the client can reconnect with the same cursor).
    set.add(sub)
    if (this.heartbeatMs > 0) {
      sub.timer = setInterval(() => {
        if (sub.active) sink({ kind: 'heartbeat' })
      }, this.heartbeatMs)
      // Never hold the process open for a heartbeat timer.
      ;(sub.timer as unknown as { unref?: () => void }).unref?.()
    }
    this.deliverReplay(sub)
    return () => this.unsubscribe(sub)
  }

  /** Fan out one persisted event; subscribers already past it are skipped (idempotent). */
  publish(conversationId: string, event: StreamEvent): void {
    const set = this.subscribers.get(conversationId)
    if (!set) return
    for (const sub of [...set]) {
      if (!sub.active) continue
      if (event.seq <= sub.lastSeq) continue
      if (event.seq > sub.lastSeq + 1) this.deliverReplay(sub)
      if (event.seq > sub.lastSeq) this.deliver(sub, event)
    }
  }

  subscriberCount(conversationId: string): number {
    return this.subscribers.get(conversationId)?.size ?? 0
  }

  close(): void {
    for (const set of this.subscribers.values()) {
      for (const sub of [...set]) this.unsubscribe(sub)
    }
  }

  private deliverReplay(sub: Subscriber): void {
    let events: StreamEvent[]
    try {
      events = this.replay(sub.conversationId, sub.lastSeq)
    } catch {
      // A failed replay is not fatal for the live channel; the next reconnect retries
      // from the same cursor. Nothing is logged here (payloads may hold user text).
      return
    }
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (sub.active && event.seq > sub.lastSeq) this.deliver(sub, event)
    }
  }

  private deliver(sub: Subscriber, event: StreamEvent): void {
    sub.lastSeq = event.seq
    sub.sink(toFrame(event))
  }

  private unsubscribe(sub: Subscriber): void {
    if (!sub.active) return
    sub.active = false
    if (sub.timer !== null) clearInterval(sub.timer)
    sub.timer = null
    const set = this.subscribers.get(sub.conversationId)
    if (!set) return
    set.delete(sub)
    if (set.size === 0) this.subscribers.delete(sub.conversationId)
  }
}
