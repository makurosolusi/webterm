// Status bar items for the Output panel: error and warning counts like VS Code's Problems
// indicator (two adjacent items, icon + count each; the icon slot is a fixed 16px, so one item
// cannot carry both). Both toggle the panel.
import { useMemo } from 'react'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { isMacPlatform } from '../terminalKeys'
import { outputShortcutLabel } from './outputChord'
import { toggleOutput, useOutputPanelState } from './outputCommands'

const codicon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden />

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Right-hand status bar items that show log error/warning counts and toggle the Output panel. */
export function useOutputStatusItems(): VscodeStatusItem[] {
  const { counts } = useOutputPanelState()
  return useMemo<VscodeStatusItem[]>(() => {
    const tooltip = `Toggle Output (${outputShortcutLabel(isMacPlatform())})`
    return [
      { id: 'output-errors', label: String(counts.error), icon: codicon('error'), tooltip,
        ariaLabel: `${tooltip}, ${plural(counts.error, 'error')}`, onClick: toggleOutput },
      { id: 'output-warnings', label: String(counts.warn), icon: codicon('warning'), tooltip,
        ariaLabel: `${tooltip}, ${plural(counts.warn, 'warning')}`, onClick: toggleOutput },
    ]
  }, [counts.error, counts.warn])
}
