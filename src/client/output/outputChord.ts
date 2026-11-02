// The Toggle Output chord, kept free of React and of module state so `terminalKeys` can import it
// without a cycle.
import type { TerminalKeyEvent } from '../terminalKeys'

/**
 * ⇧⌘U (macOS) / Ctrl+Shift+U. Shares the shape of `isCleanViewChord`, and `terminalKeyAction`
 * asks this same predicate so xterm lets the chord bubble to the window instead of eating it
 * (Ctrl+Shift+U would otherwise reach the shell as Ctrl+U). Positional (`code`) so it survives
 * non-Latin layouts; the primary modifier is per platform, as in VS Code.
 */
export function isOutputToggleChord(e: TerminalKeyEvent, isMac: boolean): boolean {
  if (e.type !== 'keydown' || e.altKey || !e.shiftKey || e.code !== 'KeyU') return false
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** Platform-aware label for menus and tooltips. */
export function outputShortcutLabel(isMac: boolean): string {
  return isMac ? '⇧⌘U' : 'Ctrl+Shift+U'
}
