// Wire contract for the system log: server ring buffer, /api/logs responses, SSE frames and
// client-reported entries all share these shapes. Server and client both import from here.

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export type LogSource = 'server' | 'client'

export interface LogEntry {
  /** Monotonic per server process; client entries get theirs when the server receives them. */
  seq: number
  /** Epoch milliseconds. */
  ts: number
  level: LogLevel
  source: LogSource
  /** Owning subsystem: 'server' 'api' 'auth' 'pty' 'ws' 'workspace' 'fs' 'client' ... */
  channel: string
  /** Stable dotted tag: 'pty.spawn', 'auth.reject', 'http.error' ... */
  event: string
  /** Short human sentence, already redacted. */
  message: string
  ids?: { workspaceId?: string; nodeId?: string; sessionId?: string; requestId?: string }
  /** Small structured fields, already passed through redactValue. */
  data?: Record<string, unknown>
}

export interface LogChannelInfo { channel: string; count: number }

/** Response of GET /api/logs. */
export interface LogQueryResult {
  entries: LogEntry[]
  lastSeq: number
  channels: LogChannelInfo[]
  level: LogLevel
  capacity: number
  dropped: number
}

/** One entry in the body of POST /api/logs/client. */
export interface ClientLogInput {
  level: LogLevel
  event: string
  message: string
  data?: Record<string, unknown>
}

/** Narrow an unknown value to a LogLevel. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}
