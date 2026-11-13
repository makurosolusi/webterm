import { ClipboardAddon } from '@xterm/addon-clipboard'

/** OSC 52 from the app (tmux copy-mode, Claude Code's own selection) goes to `write`, i.e. the
 *  browser clipboard. Write-only: a read request (`?`) gets an empty answer, so no program in the
 *  pane, local or over ssh, can read what the user copied elsewhere. An empty write (the addon's
 *  answer to bad base64) is dropped instead of wiping the clipboard. */
export function osc52Clipboard(write: (text: string) => void): ClipboardAddon {
  return new ClipboardAddon(undefined, {
    readText: () => '',
    writeText: (_selection, text) => {
      if (text) write(text)
    },
  })
}
