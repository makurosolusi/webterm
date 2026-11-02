// Copy All / Save As for the Output panel: plain `entryText` lines, one per row.
import type { LogEntry } from '../../shared/logEntry'
import { writeClipboard } from '../clipboard'
import { entryText } from './outputFormat'

const pad = (value: number): string => String(value).padStart(2, '0')

/** `webterm-output-YYYYMMDD-HHMMSS.log` in local time. */
export function outputFileName(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `webterm-output-${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`
}

const joinLines = (entries: LogEntry[]): string => entries.map(entryText).join('\n')

/** Copy the lines to the clipboard; false when the browser refused. */
export function copyEntries(entries: LogEntry[]): Promise<boolean> {
  return writeClipboard(joinLines(entries))
}

/** Download the lines as a .log file through a temporary object URL. */
export function saveEntries(entries: LogEntry[], now = new Date()): void {
  const url = URL.createObjectURL(new Blob([`${joinLines(entries)}\n`], { type: 'text/plain' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = outputFileName(now)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
