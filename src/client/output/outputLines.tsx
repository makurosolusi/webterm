// Rows of the Output panel: `timestamp [level] [channel] message` plus id chips that fill the filter.
import { memo } from 'react'
import type { LogEntry } from '../../shared/logEntry'
import { VscodeTooltip } from '../components/vscode/vscodeTooltip'
import { entryIds, formatTimestamp, levelLabel } from './outputFormat'

/** Characters of an opaque id shown on a chip; the full id goes to the tooltip and the filter. */
const CHIP_ID_LENGTH = 8
const ID_CHIP_LABEL: Record<string, string> = {
  workspaceId: 'workspace', nodeId: 'node', sessionId: 'session', requestId: 'request',
}

function rowTitle(entry: LogEntry): string {
  const data = entry.data && Object.keys(entry.data).length > 0 ? ` ${JSON.stringify(entry.data)}` : ''
  return `${entry.event}${data}`
}

interface OutputLineProps {
  entry: LogEntry
  onChip: (value: string) => void
}

const OutputLine = memo(function OutputLine({ entry, onChip }: OutputLineProps): React.JSX.Element {
  return (
    <div className="output-line" data-level={entry.level} data-seq={entry.seq} title={rowTitle(entry)}>
      <span className="output-line__ts">{formatTimestamp(entry.ts)}</span>
      {' '}
      <span className={`output-line__level output-line__level--${entry.level}`}>[{levelLabel(entry.level)}]</span>
      {' '}
      <span className="output-line__channel">[{entry.channel}]</span>
      {' '}
      <span className="output-line__message">{entry.message}</span>
      {entryIds(entry).map(([key, value]) => (
        <VscodeTooltip key={key} content={`${key}: ${value}`}>
          <button type="button" className="output-chip" aria-label={`Filter by ${key} ${value}`}
            onClick={() => onChip(value)}>
            {ID_CHIP_LABEL[key] ?? key} {value.slice(0, CHIP_ID_LENGTH)}
          </button>
        </VscodeTooltip>
      ))}
    </div>
  )
})

export interface OutputLinesProps {
  entries: LogEntry[]
  onChip: (value: string) => void
}

/** The visible rows, oldest first. */
export function OutputLines({ entries, onChip }: OutputLinesProps): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => <OutputLine key={entry.seq} entry={entry} onChip={onChip} />)}
    </>
  )
}
