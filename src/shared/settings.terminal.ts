// Terminal slice of the app settings (xterm look, interaction, shell, buffers). `settings.ts`
// composes it into the full `Settings` type and owns the default values.

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'
export type TerminalShortcutPolicy = 'app-first' | 'terminal-first'
/** `auto` follows the OS light/dark preference (`prefers-color-scheme`). */
export type AppTheme = 'auto' | 'dark' | 'light'

export interface TerminalSettings {
  // --- Appearance: applied live to every open terminal ---
  fontSize: number
  fontFamily: string
  /** Weight of regular text; xterm's own default is `normal` (400). */
  fontWeight: number
  /** Weight of bold text; xterm's own default is `bold` (700). Lowering it keeps bold legible on
   *  thin fonts whose 700 cut turns into a smear. */
  fontWeightBold: number
  /** Draw bold text with the bright palette variant (xterm default, historical convention).
   *  When off, bold only changes weight and colours keep the meaning the program gave them. */
  drawBoldTextInBrightColors: boolean
  /** Row height as a multiple of the font size (1 = xterm default, no extra leading). */
  terminalLineHeight: number
  /** Extra horizontal gap between cells in CSS pixels (0 = xterm default). */
  terminalLetterSpacing: number
  /** Colour scheme id from the client's theme table. Hand-edited values are possible, so lookup
   *  must tolerate unknown ids by falling back to the default theme. */
  terminalTheme: string
  /** Minimum foreground/background contrast ratio, 1 to 21. 1 (xterm default) disables the
   *  adjustment; 4.5 is WCAG AA, 7 is AAA, 21 forces black or white. The renderer pays a per-cell
   *  cost for it, so leave it off unless asked. */
  terminalMinContrast: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean

  // --- Interaction ---
  /** Characters that end a word when xterm expands a double-click selection. */
  terminalWordSeparator: string
  /** Copy a finished MOUSE selection to the system clipboard. Off by default: overwriting the
   *  clipboard unasked is a surprise the user should opt into. */
  copyOnSelect: boolean
  /** Cmd +/-/0 resize the FOCUSED terminal's font (Ctrl +/-/0 outside macOS). On by default.
   *  Ctrl+- is often readline undo, so turn this off if it collides. */
  terminalFontZoomKeys: boolean
  /** Who wins a shortcut while the terminal has keyboard focus. `app-first` (default) lets app
   *  commands fire over xterm; `terminal-first` hands every chord except the terminal's own
   *  (find, copy) to the shell or TUI. */
  terminalShortcutPolicy: TerminalShortcutPolicy

  // --- Shell and buffers ---
  /** Empty string means the system's default shell. */
  defaultShell: string
  /**
   * Server-side scrollback, measured in BYTES (not lines).
   *
   * There is no tmux layer here, so what bounds history is the raw PTY ring buffer in
   * `src/server/sessions.ts` (`SCROLLBACK_BYTES`), its only real consumer. The default of 256 KiB
   * equals that constant, so exposing it as a setting changes nothing by itself. The client-side
   * limit is the separate key `scrollbackLines`; do not repurpose this one as a line count.
   */
  scrollbackBytes: number
  /**
   * Client-side xterm scrollback, measured in LINES. It feeds xterm's `scrollback` option, which
   * counts grid rows, so it cannot share a key with the byte-based server limit: reusing a byte
   * figure as a line count would hand xterm hundreds of thousands of rows per node, and the
   * memory cost (`cols x 12 B` per row) multiplies by the number of nodes on a canvas.
   */
  scrollbackLines: number
}
