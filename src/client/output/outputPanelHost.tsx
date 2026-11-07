// Owns the log stream that feeds the status bar counts and the clear / set-level commands, and
// describes Output as a tab of the shared bottom panel (`bottomPanelHost`). The body is `OutputPanel`.
import { lazy, Suspense, useEffect, useRef } from 'react'
import type { LogLevel } from '../../shared/logEntry'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import type { BottomPanelView } from '../bottomPanelHost'
import { useLogStream } from './useLogStream'
import {
  closeLevelPicker, closeOutput, publishOutputCounts, registerOutputActions, setOutputLevel,
  useOutputPanelState,
} from './outputCommands'

/** Level picker rows; labels follow VS Code's "Set Log Level…" quick pick. */
const LEVEL_ITEMS: ReadonlyArray<{ level: LogLevel; label: string }> = [
  { level: 'trace', label: 'Trace' },
  { level: 'debug', label: 'Debug' },
  { level: 'info', label: 'Info' },
  { level: 'warn', label: 'Warning' },
  { level: 'error', label: 'Error' },
]

// The log view loads when the Output tab first shows; the stream and level picker below stay eager.
const OutputPanel = lazy(() => import('./OutputPanel'))

/** Output as a bottom-panel tab; the tab's close button replaces the toolbar's. */
export function useOutputView(): BottomPanelView {
  const { open, focusToken } = useOutputPanelState()
  return {
    id: 'output', label: 'Output', tooltip: 'Output', open, onClose: closeOutput,
    render: () => <Suspense fallback={null}><OutputPanel focusFilterToken={focusToken} /></Suspense>,
  }
}

/** Always-mounted: keeps the log stream alive and renders the log-level picker. */
export default function OutputPanelHost(): React.JSX.Element {
  const { levelPickerOpen } = useOutputPanelState()
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
