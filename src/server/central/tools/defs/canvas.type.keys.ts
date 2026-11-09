// Named keys canvas.type may press, tmux send-keys style: the model names a key, never sends raw bytes.

// ponytail: arrows use normal-mode CSI (\x1b[A), not application-cursor \x1bOA; TUIs like Claude Code accept both.
const NAMED: Readonly<Record<string, string>> = {
  Enter: '\r', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', Backspace: '\x7f', Delete: '\x1b[3~', Space: ' ',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~',
}

/** The key names canvas.type accepts, for its usage text. */
export const KEY_NAMES = [...Object.keys(NAMED), 'C-a..C-z']

/** Bytes a named key sends to the terminal, or undefined for an unknown name (case-sensitive, like tmux). */
export function keyBytes(name: string): string | undefined {
  if (Object.hasOwn(NAMED, name)) return NAMED[name]
  return /^C-[a-z]$/.test(name) ? String.fromCharCode(name.charCodeAt(2) - 96) : undefined
}
