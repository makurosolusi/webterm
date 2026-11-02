import { describe, expect, it } from 'vitest'
import { entryHaystack, entryText, formatLogLine, formatTimestamp, levelLabel } from './outputFormat'
import { outputFileName } from './outputExport'
import { makeEntry } from './outputTestKit'

describe('output format', () => {
  it('formats the timestamp as YYYY-MM-DD HH:MM:SS.mmm in local time', () => {
    expect(formatTimestamp(new Date(2026, 10, 2, 21, 26, 23, 7).getTime())).toBe('2026-11-02 21:26:23.007')
  })
  it('spells warn as warning', () => {
    expect(levelLabel('warn')).toBe('warning')
    expect(levelLabel('error')).toBe('error')
  })
  it('builds the visible line', () => {
    const entry = makeEntry(0, { level: 'warn', channel: 'auth', message: 'Rejected' })
    expect(formatLogLine(entry)).toBe('2026-11-02 21:26:23.123 [warning] [auth] Rejected')
  })
  it('appends ids to copy text and includes ids and event in the haystack', () => {
    const entry = makeEntry(0, { ids: { nodeId: 'n-1', requestId: 'r-9' } })
    expect(entryText(entry)).toBe('2026-11-02 21:26:23.123 [info] [pty] message 0 nodeId=n-1 requestId=r-9')
    expect(entryHaystack(entry)).toContain('n-1')
    expect(entryHaystack(entry)).toContain('pty.spawn')
  })
  it('names save files by local time', () => {
    expect(outputFileName(new Date(2026, 10, 2, 9, 5, 3))).toBe('webterm-output-20261102-090503.log')
  })
})
