// Tab-layout chords, shared by the command registry (strings) and xterm's key handler (predicates:
// without them xterm eats Ctrl+Shift+L as Ctrl+L and the shortcut never reaches the window).
// Positional (`code`) so they survive non-Latin layouts; kept free of React and module state so
// `terminalKeys` can import it without a cycle.
import type { TerminalKeyEvent } from './terminalKeys'

export const TOGGLE_LAYOUT_KEY = 'Mod+Shift+L'
export const PREV_TAB_KEY = 'Mod+Shift+['
export const NEXT_TAB_KEY = 'Mod+Shift+]'
/** Ctrl+W is readline word-rubout and the browser's own close-tab, so only macOS gets the bare chord. */
export const closeTabKey = (isMac: boolean): string => (isMac ? 'Mod+W' : 'Mod+Alt+W')

const primary = (e: TerminalKeyEvent, isMac: boolean): boolean => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

/** True for the chords above: xterm must let them bubble to the window dispatcher. */
export function isTabLayoutChord(e: TerminalKeyEvent, isMac: boolean): boolean {
  if (e.type !== 'keydown' || !primary(e, isMac)) return false
  if (e.shiftKey) return !e.altKey && (e.code === 'KeyL' || e.code === 'BracketLeft' || e.code === 'BracketRight')
  return e.code === 'KeyW' && (isMac ? !e.altKey : e.altKey)
}
