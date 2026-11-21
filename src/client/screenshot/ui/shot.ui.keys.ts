// Keyboard map of the overlay (pure). While the overlay is open it is modal: every keydown is handled
// here or ignored, and none reaches the app's global shortcuts.
import { eventChord } from '@/commandRegistry'
import { commandMatches } from '@/keybindings.resolve'
import { SCREENSHOT_COMMAND_ID } from './shot.ui.text'

export type KeyIntent = 'close' | 'selectAll' | 'undo' | 'redo' | 'copy' | 'save'
type KeyLike = Parameters<typeof eventChord>[0]

const CHORDS: Record<string, KeyIntent> = {
  Escape: 'close', Enter: 'selectAll', 'Mod+Z': 'undo', 'Mod+Shift+Z': 'redo', 'Mod+Y': 'redo', 'Mod+C': 'copy', 'Mod+S': 'save',
}
/** Keys a text field or a focused button owns: the overlay must not take them. */
const OWNED_BY_FIELD = new Set<KeyIntent>(['undo', 'redo', 'copy', 'selectAll'])

/**
 * What a keydown means. `target` is the focused element: Enter on a button activates it, and inside the
 * text field undo/copy keep their text meaning (Mod+S and the toggle chord still work there).
 */
export function keyIntent(e: KeyLike, target: EventTarget | null, isMac: boolean): KeyIntent | null {
  // The screenshot command's own (possibly rebound) chord toggles: pressing it again closes.
  if (commandMatches(e, SCREENSHOT_COMMAND_ID, undefined, undefined, isMac)) return 'close'
  const intent = CHORDS[eventChord(e, isMac)]
  if (!intent) return null
  const el = target instanceof HTMLElement ? target : null
  const inField = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
  if (inField && OWNED_BY_FIELD.has(intent)) return null
  if (intent === 'selectAll' && el && el.closest('button')) return null
  return intent
}
