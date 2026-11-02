// Mounts the Output panel as a bottom panel and owns the log stream that feeds the status bar
// counts and the clear / set-level commands. The panel body itself is `OutputPanel`.
import { useEffect, useRef } from 'react'
import type { LogLevel } from '../../shared/logEntry'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import { InboxPanelSurface } from '../inboxPanelSurface'
import type { BottomPanelTab } from '../bottomPanelTabs'
import OutputPanel from './OutputPanel'
import { useLogStream } from './useLogStream'
import {
  closeLevelPicker, closeOutput, publishOutputCounts, registerOutputActions, setOutputLevel,
  useOutputPanelState,
} from './outputCommands'
import './outputHost.css'

const TABS: BottomPanelTab[] = [{ id: 'output', label: 'Output', closable: false, tooltip: 'Output' }]

/** Level picker rows; labels follow VS Code's "Set Log Level…" quick pick. */
const LEVEL_ITEMS: ReadonlyArray<{ level: LogLevel; label: string }> = [
  { level: 'trace', label: 'Trace' },
  { level: 'debug', label: 'Debug' },
  { level: 'info', label: 'Info' },
  { level: 'warn', label: 'Warning' },
  { level: 'error', label: 'Error' },
]

const noop = (): void => {}

/** Always-mounted host; renders the panel only while Output is open. */
export default function OutputPanelHost(): React.JSX.Element {
  const { open, focusToken, levelPickerOpen } = useOutputPanelState()
  const stream = useLogStream()
  const streamRef = useRef(stream)
  streamRef.current = stream

  useEffect(
    () => registerOutputActions({
      clear: () => streamRef.current.clear(),
      setLevel: (level) => streamRef.current.setLevel(level),
    }),
    [],
  )
  useEffect(() => { publishOutputCounts(stream.counts) }, [stream.counts.error, stream.counts.warn])

  const levelItems: VscodeQuickPickItem[] = LEVEL_ITEMS.map(({ level, label }) => ({
    id: level, label, ...(level === stream.level ? { description: 'Current' } : {}),
  }))

  return (
    <>
      {open && (
        <InboxPanelSurface className="output-panel-host" ariaLabel="Output" tabs={TABS} activeId="output" onActivate={noop}>
          <OutputPanel onClose={closeOutput} focusFilterToken={focusToken} />
        </InboxPanelSurface>
      )}
      {levelPickerOpen && (
        <VscodeQuickPick
          open
          onClose={closeLevelPicker}
          ariaLabel="Set Log Level"
          placeholder="Select log level"
          items={levelItems}
          onSelect={(id) => { closeLevelPicker(); void setOutputLevel(id as LogLevel) }}
        />
      )}
    </>
  )
}
