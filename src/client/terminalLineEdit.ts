import { isMacPlatform, type TerminalKeyEvent } from './terminalKeys'

/** Kill-line readline (^U), awal baris (^A), akhir baris (^E), undo readline (^_), dan `ESC d`. */
const KILL_LINE = '\x15'
const LINE_START = '\x01'
const LINE_END = '\x05'
const UNDO = '\x1f'
const KILL_WORD_FORWARD = '\x1bd'

/**
 * Edit baris ala Terminal.app/iTerm yang tidak dikirim xterm apa adanya, MURNI keydown:
 * - ⌘⌫ → ^U, ⌘← → ^A, ⌘→ → ^E (macOS, tanpa modifier lain).
 * - ⌥⌦ (forward delete) → `ESC d` (macOS).
 * - Ctrl+/ → ^_ (undo readline), semua platform, ctrl saja.
 *
 * SENGAJA tidak memetakan ⌘↑/↓, Shift+panah, dan Option+↑/↓: TUI (vim, Claude Code) memakainya.
 */
export function lineEditSeq(
  e: TerminalKeyEvent,
  isMac: boolean = isMacPlatform(),
): string | null {
  if (e.type !== 'keydown') return null
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === '/') return UNDO
  if (!isMac) return null
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (e.key === 'Backspace') return KILL_LINE
    if (e.key === 'ArrowLeft') return LINE_START
    if (e.key === 'ArrowRight') return LINE_END
    return null
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'Delete') {
    return KILL_WORD_FORWARD
  }
  return null
}
