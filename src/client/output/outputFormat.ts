// Plain-text rendering of a log entry: the visible line, the copy/save text and the filter haystack.
import type { LogEntry, LogLevel } from '../../shared/logEntry'

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** Local time as `YYYY-MM-DD HH:MM:SS.mmm`, the VS Code log timestamp. */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** VS Code spells the `warn` level `warning`. */
export function levelLabel(level: LogLevel): string {
  return level === 'warn' ? 'warning' : level
}

/** `YYYY-MM-DD HH:MM:SS.mmm [level] [channel] message`. */
export function formatLogLine(entry: LogEntry): string {
  return `${formatTimestamp(entry.ts)} [${levelLabel(entry.level)}] [${entry.channel}] ${entry.message}`
}

/** Opaque ids carried by an entry, as `[key, value]` pairs in a stable order. */
export function entryIds(entry: LogEntry): Array<[string, string]> {
  if (!entry.ids) return []
  return (['workspaceId', 'nodeId', 'sessionId', 'requestId'] as const)
    .flatMap((key) => {
      const value = entry.ids?.[key]
      return value ? [[key, value] as [string, string]] : []
    })
}

/** Line used for Copy All / Save As: the visible line plus `key=value` ids. */
export function entryText(entry: LogEntry): string {
  const ids = entryIds(entry).map(([key, value]) => `${key}=${value}`).join(' ')
  return ids === '' ? formatLogLine(entry) : `${formatLogLine(entry)} ${ids}`
}

const haystacks = new WeakMap<LogEntry, string>()

/** Text the filter matches against: the line, ids and the event tag (cached per entry). */
export function entryHaystack(entry: LogEntry): string {
  let cached = haystacks.get(entry)
  if (cached === undefined) {
    cached = `${entryText(entry)} ${entry.event}`
    haystacks.set(entry, cached)
  }
  return cached
}
