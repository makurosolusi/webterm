import type { Terminal } from '@xterm/xterm'
import type { ClipboardAddon } from '@xterm/addon-clipboard'

/** OSC 52 from the app (tmux copy-mode, Claude Code's own selection) goes to `write`, i.e. the
 *  browser clipboard. Write-only: a read request (`?`) gets an empty answer, so no program in the
 *  pane, local or over ssh, can read what the user copied elsewhere. An empty write (the addon's
 *  answer to bad base64) is dropped instead of wiping the clipboard.
 *
 *  The addon is imported lazily: its UMD bundle touches `self` while the module evaluates, so a
 *  static import breaks every node-environment test that reaches TerminalCore. `alive` is checked
 *  after the import so a terminal disposed meanwhile never gets the addon. Resolves to the loaded
 *  addon, or undefined when the terminal went away or the bundle failed to load (warned, the
 *  terminal keeps working without app-driven copy). */
export async function loadOsc52Clipboard(
  term: Terminal,
  write: (text: string) => void,
  alive: () => boolean,
  label: string,
): Promise<ClipboardAddon | undefined> {
  let mod: typeof import('@xterm/addon-clipboard')
  try {
    mod = await import('@xterm/addon-clipboard')
  } catch (err) {
    console.warn(`terminal ${label}: OSC 52 clipboard addon failed to load, app copy is disabled`, err)
    return undefined
  }
  if (!alive()) return undefined
  const addon = new mod.ClipboardAddon(undefined, {
    readText: () => '',
    writeText: (_selection, text) => {
      if (text) write(text)
    },
  })
  term.loadAddon(addon)
  return addon
}
