// The agent's VISIBLE SCREEN, rebuilt server-side from the raw PTY output. webterm has no tmux to
// `capture-pane -e` (the usual tmux capture), but it keeps every session's output
// log, so replaying that log through the same terminal emulator the client uses (`@xterm/xterm`,
// already a dependency, runs headless in Bun/Node as long as `open()` is never called) gives the same
// screen the user is looking at. The result is in the shape `readClaudeComposer` reads: one line per
// row, with SGR 2 / 22 around dim runs (the only attribute the reader needs).
//
// Imported LAZILY: merely loading `@xterm/xterm` keeps a Bun process alive (measured), so only a
// process that actually reads a screen (the long-lived server) pays for it.

/** Replay `data` into a `cols`×`rows` terminal and return its visible rows, dim runs marked. */
export async function renderStyledScreen(data: string, cols: number, rows: number): Promise<string> {
  const { Terminal } = await import('@xterm/xterm')
  const term = new Terminal({ cols: Math.max(cols, 2), rows: Math.max(rows, 1), scrollback: 0, allowProposedApi: true })
  return new Promise((resolve) => {
    term.write(data, () => {
      const buf = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(buf.viewportY + y)
        let s = ''
        let dim = false
        for (let x = 0; line && x < term.cols; x++) {
          const cell = line.getCell(x)
          if (!cell || cell.getWidth() === 0) continue // right half of a wide char
          const d = cell.isDim() !== 0
          if (d !== dim) { s += d ? '\x1b[2m' : '\x1b[22m'; dim = d }
          s += cell.getChars() || ' '
        }
        out.push(dim ? `${s}\x1b[22m` : s)
      }
      term.dispose()
      resolve(out.join('\n'))
    })
  })
}
