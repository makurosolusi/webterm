// Structured logger. `createLogger('pty').info('pty.spawn', 'Spawned shell', { ids: { nodeId } })`.
// Never throws, drops below-level calls before doing any work, and writes to: ring buffer (-> API/SSE),
// console mirror, and the daily file sink.
import { isLogLevel, LOG_LEVELS, type LogEntry, type LogLevel } from '../../shared/logEntry'
import { parseFlag } from '../envFlag'
import { logBus, parseCapacity } from './logBus'
import { mirrorToConsole } from './logConsole'
import { retentionFromEnv, startLogRetention, type RetentionPolicy } from './logRetention'
import { createFileSink, type FileSink } from './logFileSink'
import { MAX_EVENT_CHARS, MAX_MESSAGE_CHARS, safeText, sanitizeData, sanitizeIds } from './logSanitize'

export type LogFields = Record<string, unknown> & { ids?: LogEntry['ids'] }

export interface Logger {
  trace(event: string, message: string, fields?: LogFields): void
  debug(event: string, message: string, fields?: LogFields): void
  info(event: string, message: string, fields?: LogFields): void
  warn(event: string, message: string, fields?: LogFields): void
  error(event: string, message: string, fields?: LogFields): void
  /** Child channel: `createLogger('channels').child('telegram')` logs as `channels.telegram`. */
  child(channel: string): Logger
  /** Same logger, with ids merged into every entry it writes. */
  withIds(ids: LogEntry['ids']): Logger
}

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

interface State { level: LogLevel; console: boolean; sink: FileSink | null; stopRetention: (() => void) | null; retention: RetentionPolicy }

/** Parse WEBTERM_LOG_LEVEL; unknown values yield undefined so the caller keeps its current level. */
function parseLevel(raw: string | undefined): LogLevel | undefined {
  const level = raw?.trim().toLowerCase()
  return isLogLevel(level) ? level : undefined
}

const state: State = { level: parseLevel(process.env.WEBTERM_LOG_LEVEL) ?? DEFAULT_LOG_LEVEL, console: true, sink: null, stopRetention: null, retention: retentionFromEnv({}) }

export const getLogLevel = (): LogLevel => state.level
/** Directory of the active file sink, or null when file logging is off. */
export const getLogDir = (): string | null => state.sink?.dir ?? null
export const getRetention = (): RetentionPolicy => state.retention
export const setLogLevel = (level: LogLevel): void => { state.level = level }

const enabled = (level: LogLevel): boolean => LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(state.level)

/** Record one entry from any source. Returns the stored entry, or null when below level / on failure. */
export function recordEntry(input: Omit<LogEntry, 'seq' | 'ts'> & { ts?: number }): LogEntry | null {
  if (!enabled(input.level)) return null
  try {
    const entry = logBus.append({
      ts: input.ts ?? Date.now(),
      level: input.level,
      source: input.source,
      channel: safeText(input.channel, MAX_EVENT_CHARS),
      event: safeText(input.event, MAX_EVENT_CHARS),
      message: safeText(input.message, MAX_MESSAGE_CHARS),
      ids: sanitizeIds(input.ids),
      data: sanitizeData(input.data),
    })
    if (input.source === 'server' && state.console) mirrorToConsole(entry)
    state.sink?.write(entry)
    return entry
  } catch (err) {
    process.stderr.write(`logger failed for ${String(input.event)}: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
}

function make(channel: string, baseIds: LogEntry['ids']): Logger {
  const write = (level: LogLevel) => (event: string, message: string, fields?: LogFields): void => {
    if (!enabled(level)) return
    let ids = baseIds
    let data: Record<string, unknown> | undefined
    if (fields) {
      const { ids: own, ...rest } = fields
      ids = own || baseIds ? { ...baseIds, ...own } : undefined
      data = rest
    }
    recordEntry({ level, source: 'server', channel, event, message, ids, data })
  }
  return {
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (name) => make(`${channel}.${name}`, baseIds),
    withIds: (ids) => make(channel, { ...baseIds, ...ids }),
  }
}

/** Logger bound to a channel (subsystem name). */
export function createLogger(channel: string): Logger {
  return make(channel, undefined)
}

export interface LoggingConfig {
  env?: NodeJS.ProcessEnv
  /** Directory for the daily files; omitted = file sink off. */
  dir?: string
  console?: boolean
}

/**
 * Apply env-driven config once env overrides are in place: level, buffer capacity, file sink.
 * Entries logged earlier (module load) are replayed into the new sink so the file is complete.
 */
export function configureLogging(config: LoggingConfig = {}): void {
  const env = config.env ?? process.env
  state.level = parseLevel(env.WEBTERM_LOG_LEVEL) ?? state.level
  logBus.setCapacity(parseCapacity(env.WEBTERM_LOG_BUFFER))
  if (config.console !== undefined) state.console = config.console
  const fileOn = parseFlag(env.WEBTERM_LOG_FILE) !== 'off'
  if (fileOn && config.dir && state.sink?.dir !== config.dir) {
    const sink = createFileSink({ dir: config.dir })
    for (const entry of logBus.snapshot()) sink.write(entry)
    state.sink = sink
    state.stopRetention?.()
    state.retention = retentionFromEnv(env)
    state.stopRetention = startLogRetention(config.dir, state.retention, (r, p) => recordEntry({
      level: 'info', source: 'server', channel: 'logs', event: 'logs.purged', message: `Removed ${r.removedFiles} old log file(s), freed ${r.freedBytes} bytes`,
      data: { removedFiles: r.removedFiles, freedBytes: r.freedBytes, remainingBytes: r.remainingBytes, maxAgeDays: p.maxAgeDays, maxBytes: p.maxBytes },
    }))
  } else if (!fileOn || !config.dir) {
    state.stopRetention?.()
    state.stopRetention = null
    state.sink = null
  }
}

/** Flush the file sink: async for tests/shutdown awaiting, sync for process exit. */
export const flushLogs = (): Promise<void> => state.sink?.flush() ?? Promise.resolve()
export const flushLogsSync = (): void => state.sink?.flushSync()
