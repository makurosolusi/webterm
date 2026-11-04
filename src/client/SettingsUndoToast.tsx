// Settings undo surface (F3-d): the "Changed X · Undo" toast and the ⌘Z / ⇧⌘Z handler of the
// Settings panel. The history itself lives in `./settingsHistory`, owned by `useSettings`.
import { useRef, useState } from 'react'
import type React from 'react'
import { VscodeNotification } from './components/vscode/vscodeNotification'
import { settingsKeyLabel } from './settingsHistory'
import type { SettingsUndo } from './useSettings'

/** Toast slot id, so the dialog can tell a click on it from a click outside (which closes). */
export const SETTINGS_UNDO_TOAST_SLOT = 'vscode-notification-stack'

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'])

/** True when ⌘Z belongs to the browser's own text undo (a text field with something to undo). */
function ownsTextUndo(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t instanceof HTMLTextAreaElement) return true
  if (!(t instanceof HTMLInputElement) || NON_TEXT_INPUTS.has(t.type)) return false
  // The empty search box (focused on open) has no text to undo, so ⌘Z there means "undo setting".
  return !(t.type === 'search' && t.value === '')
}

/** onKeyDown for the panel: ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Shift+Z redo. */
export function settingsUndoKeyDown(history: SettingsUndo | undefined) {
  return (e: React.KeyboardEvent): void => {
    if (!history || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return
    if (ownsTextUndo(e.target)) return
    e.preventDefault()
    if (e.shiftKey) history.redo()
    else history.undo()
  }
}

const TITLE = { changed: 'Changed', undone: 'Undid change to', redone: 'Redid change to' } as const

/** Toast for the latest change made while the panel is open (older notices stay silent). */
export function SettingsUndoToast({ history }: { history: SettingsUndo | undefined }): React.JSX.Element | null {
  const openedAt = useRef(history?.notice?.seq ?? 0)
  const [dismissed, setDismissed] = useState(0)
  const n = history?.notice
  if (!history || !n || n.seq <= openedAt.current || n.seq === dismissed) return null
  const action = n.kind === 'undone'
    ? { label: 'Redo', onClick: history.redo }
    : { label: 'Undo', onClick: history.undo }
  return (
    <VscodeNotification
      key={n.seq}
      id={`settings-undo-${n.seq}`}
      severity="info"
      title={`${TITLE[n.kind]} ${settingsKeyLabel(n.change.keys)}`}
      actions={[action]}
      onClose={() => setDismissed(n.seq)}
    />
  )
}
