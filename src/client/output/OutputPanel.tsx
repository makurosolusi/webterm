// VS Code style Output panel body: toolbar + monospace log. Mounted by the bottom panel shell.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { LogLevel } from '../../shared/logEntry'
import { copyEntries, saveEntries } from './outputExport'
import { entryHaystack } from './outputFormat'
import { escapeFilterTerm, matchesFilter, parseFilter } from './outputFilter'
import { OutputLines } from './outputLines'
import { ALL_CHANNELS, OutputToolbar } from './outputToolbar'
import { useLogStream } from './useLogStream'
import './outputPanel.css'

export { useLogStream } from './useLogStream'

/** Distance from the bottom (px) still counted as "at the bottom" for auto-scroll. */
const BOTTOM_TOLERANCE_PX = 4

export interface OutputPanelProps {
  onClose: () => void
  /** Bump to move focus to the filter box (Ctrl/Cmd+F style commands). */
  focusFilterToken?: number
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Output panel: channel/level dropdowns, filter, Clear, auto-scroll lock, Copy/Save, Close. */
export function OutputPanel({ onClose, focusFilterToken }: OutputPanelProps): React.JSX.Element {
  const { entries, channels, level, clear, setLevel } = useLogStream()
  const [channel, setChannel] = useState(ALL_CHANNELS)
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const matching = useMemo(() => {
    const parsed = parseFilter(filter)
    return entries.filter((entry) =>
      (channel === ALL_CHANNELS || entry.channel === channel) && matchesFilter(parsed, entryHaystack(entry)))
  }, [entries, channel, filter])
  // The client ring (LOG_CLIENT_CAP rows) is also the render cap: filtering only narrows it.
  const lastSeq = matching.length > 0 ? matching[matching.length - 1]!.seq : 0
  useLayoutEffect(() => {
    const el = logRef.current
    if (autoScroll && el) el.scrollTop = el.scrollHeight
  }, [autoScroll, lastSeq, matching.length])

  const focusFilter = useCallback((): void => {
    filterRef.current?.focus()
    filterRef.current?.select()
  }, [])
  const lastToken = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (focusFilterToken === undefined || focusFilterToken === lastToken.current) return
    const first = lastToken.current === undefined
    lastToken.current = focusFilterToken
    if (!first || focusFilterToken > 0) focusFilter()
  }, [focusFilterToken, focusFilter])

  const onScroll = (): void => {
    const el = logRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE_PX)
  }

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice(`${label}: ${errorText(error)}`)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      focusFilter()
    }
  }

  return (
    <div className="output-panel" role="region" aria-label="Output" onKeyDown={onKeyDown}>
      <OutputToolbar
        channels={channels} channel={channel} onChannel={setChannel}
        level={level} onLevel={(next: LogLevel) => void run('Could not set the log level', () => setLevel(next))}
        filter={filter} onFilter={setFilter} filterRef={filterRef}
        autoScroll={autoScroll}
        onToggleAutoScroll={() => setAutoScroll((on) => !on)}
        hasEntries={matching.length > 0}
        onClear={() => void run('Could not clear the output', clear)}
        onCopy={() => void run('Could not copy', async () => {
          if (!(await copyEntries(matching))) throw new Error('clipboard unavailable')
        })}
        onSave={() => void run('Could not save', async () => saveEntries(matching))}
        onClose={onClose}
      />
      {notice !== null && <div className="output-notice" role="alert">{notice}</div>}
      <div className="output-body">
        <div ref={logRef} className="output-log" role="log" aria-live="off" aria-label="Output log" tabIndex={0}
          onScroll={onScroll}>
          <OutputLines entries={matching} onChip={(value) => setFilter(escapeFilterTerm(value))} />
        </div>
        {matching.length === 0 && (
          <div className="output-empty" role="status">
            {entries.length === 0 ? 'No log entries' : 'No results found with provided filter criteria.'}
          </div>
        )}
      </div>
    </div>
  )
}

export default OutputPanel
