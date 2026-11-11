// Status bar items for the Output panel: error and warning counts like VS Code's Problems
// indicator (two adjacent items, icon + count each; the icon slot is a fixed 16px, so one item
// cannot carry both). Both toggle the panel.
import { useMemo } from 'react'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { toggleOutput, useOutputPanelState } from './outputCommands'

const codicon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden />

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Right-hand status bar items that show log error/warning counts and toggle the Output panel. */
export function useOutputStatusItems(): VscodeStatusItem[] {
  const { counts } = useOutputPanelState()
  return useMemo<VscodeStatusItem[]>(() => {
    return [
      { id: 'output-errors', label: String(counts.error), icon: codicon('error'), commandId: 'output.toggle',
        tooltip: `${plural(counts.error, 'error')} in the log — toggle Output`,
        ariaLabel: `Toggle Output, ${plural(counts.error, 'error')}`, onClick: toggleOutput },
      { id: 'output-warnings', label: String(counts.warn), icon: codicon('warning'), commandId: 'output.toggle',
        tooltip: `${plural(counts.warn, 'warning')} in the log — toggle Output`,
        ariaLabel: `Toggle Output, ${plural(counts.warn, 'warning')}`, onClick: toggleOutput },
    ]
  }, [counts.error, counts.warn])
}
