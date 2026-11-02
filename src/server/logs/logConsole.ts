// Console mirror: keeps `bun run dev` informative with a VS Code-ish line per entry.
import type { LogEntry } from '../../shared/logEntry'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `HH:MM:SS.mmm [level] [channel] message` plus compact ids/data when present. */
export function formatConsoleLine(entry: LogEntry): string {
  const d = new Date(entry.ts)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  const extra = entry.ids || entry.data ? ` ${JSON.stringify({ ...entry.ids, ...entry.data })}` : ''
  return `${time} [${entry.level}] [${entry.channel}] ${entry.message}${extra}`
}

/** Print through console.* so existing tests that spy on console still observe server output. */
export function mirrorToConsole(entry: LogEntry): void {
  const line = formatConsoleLine(entry)
  if (entry.level === 'error') console.error(line)
  else if (entry.level === 'warn') console.warn(line)
  else console.log(line)
}
