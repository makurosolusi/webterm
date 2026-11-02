// In-memory ring buffer + fan-out for log entries. Pure data structure: no I/O, never throws to the
// caller, safe to use from any module. The process-wide instance is `logBus`.
import { LOG_LEVELS, type LogChannelInfo, type LogEntry, type LogLevel } from '../../shared/logEntry'

export const DEFAULT_LOG_BUFFER = 5000
export const MIN_LOG_BUFFER = 100
export const MAX_LOG_BUFFER = 100_000

export type NewLogEntry = Omit<LogEntry, 'seq'>
export type LogListener = (entry: LogEntry) => void

/** Parse WEBTERM_LOG_BUFFER: integer within bounds, anything else falls back to the default. */
export function parseCapacity(raw: string | undefined): number {
  const n = Number((raw ?? '').trim())
  return Number.isInteger(n) && n >= MIN_LOG_BUFFER && n <= MAX_LOG_BUFFER ? n : DEFAULT_LOG_BUFFER
}

export interface LogQuery {
  afterSeq?: number
  limit?: number
  level?: LogLevel
  channel?: string
  q?: string
}

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level)

/** Channel filter: exact match or a parent ('channels' matches 'channels.telegram'). */
function channelMatches(entry: string, wanted: string): boolean {
  return entry === wanted || entry.startsWith(`${wanted}.`)
}

/** Does `entry` pass every filter in `query` (afterSeq/limit are applied by the caller)? */
export function matchesQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.level && rank(entry.level) < rank(query.level)) return false
  if (query.channel && !channelMatches(entry.channel, query.channel)) return false
  if (query.q) {
    const needle = query.q.toLowerCase()
    const hay = `${entry.channel} ${entry.event} ${entry.message}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }
  return true
}

export function createLogBus(initialCapacity = DEFAULT_LOG_BUFFER) {
  let capacity = initialCapacity
  let buffer: LogEntry[] = []
  let seq = 0
  let dropped = 0
  const listeners = new Set<LogListener>()

  function emit(entry: LogEntry): void {
    for (const listener of [...listeners]) {
      try {
        listener(entry)
      } catch (err) {
        // A broken subscriber must not break logging; it is removed and reported out-of-band
        // (stderr, not the bus, so a failing listener cannot feed itself).
        listeners.delete(listener)
        process.stderr.write(`logBus: listener removed after error: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  return {
    /** Assign the next seq, store (evicting the oldest past capacity) and notify subscribers. */
    append(input: NewLogEntry): LogEntry {
      const entry: LogEntry = { seq: ++seq, ...input }
      buffer.push(entry)
      if (buffer.length > capacity) {
        const over = buffer.length - capacity
        buffer = buffer.slice(over)
        dropped += over
      }
      emit(entry)
      return entry
    },
    /** Entries matching `query`: resume (afterSeq>0) returns the oldest `limit` after it, else the newest `limit`. */
    query(query: LogQuery = {}): LogEntry[] {
      const limit = Math.max(1, query.limit ?? capacity)
      const after = query.afterSeq ?? 0
      const hits = buffer.filter((e) => e.seq > after && matchesQuery(e, query))
      return after > 0 ? hits.slice(0, limit) : hits.slice(-limit)
    },
    /** Per-channel counts over the whole buffer, sorted by name. */
    channels(): LogChannelInfo[] {
      const counts = new Map<string, number>()
      for (const e of buffer) counts.set(e.channel, (counts.get(e.channel) ?? 0) + 1)
      return [...counts].map(([channel, count]) => ({ channel, count })).sort((a, b) => a.channel.localeCompare(b.channel))
    },
    /** Subscribe to new entries; returns the unsubscribe function. */
    subscribe(listener: LogListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Empty the buffer (seq keeps counting, dropped is untouched: clearing is not eviction). */
    clear(): void { buffer = [] },
    /** Resize; shrinking evicts the oldest and counts them as dropped. */
    setCapacity(next: number): void {
      capacity = next
      if (buffer.length > capacity) {
        dropped += buffer.length - capacity
        buffer = buffer.slice(buffer.length - capacity)
      }
    },
    snapshot(): LogEntry[] { return [...buffer] },
    get lastSeq(): number { return seq },
    get capacity(): number { return capacity },
    get dropped(): number { return dropped },
    get subscriberCount(): number { return listeners.size },
  }
}

export type LogBus = ReturnType<typeof createLogBus>

/** Process-wide bus. Capacity is re-read from env by `initLogging` once env overrides are applied. */
export const logBus: LogBus = createLogBus(parseCapacity(process.env.WEBTERM_LOG_BUFFER))
