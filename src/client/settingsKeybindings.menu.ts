// Row context menu of Settings › Keyboard Shortcuts, VS Code's Keyboard Shortcuts editor menu: Change /
// Remove / Reset Keybinding, Copy, Copy Command ID, Show Same Keybindings. Reset is listed only for a
// User binding; a fixed built-in offers no edits.
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { chordLabel } from './commandRegistry'
import type { EffectiveBinding } from './keybindings.resolve'
import { ROW_TEXT } from './SettingsKeybindingRow'

export const MENU_TEXT = {
  change: 'Change Keybinding…',
  remove: 'Remove Keybinding',
  reset: 'Reset Keybinding',
  copy: 'Copy Keybinding',
  copyId: 'Copy Command ID',
  copyTitle: 'Copy Command Title',
  showSame: 'Show Same Keybindings',
} as const

export interface RowMenuActions {
  record: (id: string) => void
  remove: (id: string) => void
  reset: (id: string) => void
  showSame: (chord: string) => void
}

function copy(text: string): void {
  if (!navigator.clipboard) { console.warn('[keybindings] copy failed: no clipboard access'); return }
  navigator.clipboard.writeText(text).catch((err: unknown) => console.warn('[keybindings] copy failed', err))
}

export function rowMenuItems(b: EffectiveBinding, isMac: boolean, a: RowMenuActions): VscodeMenuItem[] {
  const { cmd, key } = b
  const fixed = cmd.fixed ? ROW_TEXT.fixed : undefined
  return [
    { type: 'item', id: 'change', label: MENU_TEXT.change, disabled: !!cmd.fixed, title: fixed, onSelect: () => a.record(cmd.id) },
    { type: 'item', id: 'remove', label: MENU_TEXT.remove, disabled: !!cmd.fixed || !key, title: fixed, onSelect: () => a.remove(cmd.id) },
    ...(b.source === 'user' ? [{ type: 'item' as const, id: 'reset', label: MENU_TEXT.reset, onSelect: () => a.reset(cmd.id) }] : []),
    { type: 'separator' },
    { type: 'item', id: 'copy', label: MENU_TEXT.copy, disabled: !key, onSelect: () => key && copy(chordLabel(key, isMac)) },
    { type: 'item', id: 'copyId', label: MENU_TEXT.copyId, onSelect: () => copy(cmd.id) },
    { type: 'item', id: 'copyTitle', label: MENU_TEXT.copyTitle, onSelect: () => copy(cmd.label) },
    { type: 'separator' },
    { type: 'item', id: 'showSame', label: MENU_TEXT.showSame, disabled: !key, onSelect: () => key && a.showSame(key) },
  ]
}
