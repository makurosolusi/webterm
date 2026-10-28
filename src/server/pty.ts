// Bun-native PTY wrapper. node-pty's POSIX spawn is broken under Bun, so we use
// Bun.Terminal + Bun.spawn (verified on Bun 1.4.2). Bun's globals are typed
// locally on purpose: @types/bun ships a global `fetch` override that reddens
// unrelated files, so we declare only the slice we use.
declare namespace Bun {
  interface Terminal { write(data: string): void; resize(cols: number, rows: number): void; close(): void }
  interface TerminalConstructor {
    new (options: { name?: string; cols?: number; rows?: number; data: (terminal: Terminal, bytes: Uint8Array) => void }): Terminal
  }
  interface Subprocess { readonly pid: number; readonly exited: Promise<number>; kill(signal?: number): void }
}
declare const Bun: {
  Terminal: Bun.TerminalConstructor
  spawn(cmd: string[], options: { terminal: Bun.Terminal; cwd?: string; env?: Record<string, string> }): Bun.Subprocess
}

export interface Pty {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.TERM = 'xterm-256color'
  return env
}

export function spawnPty(opts: { cols: number; rows: number; cwd?: string; cmd?: string; env?: Record<string, string> }): Pty {
  let onData: (data: string) => void = () => {}
  let onExit: (code: number) => void = () => {}
  // Streaming decoder so a multi-byte UTF-8 rune split across two read chunks
  // is not mangled into replacement characters.
  const decoder = new TextDecoder('utf-8')

  const terminal = new Bun.Terminal({
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    data: (_t, bytes) => onData(decoder.decode(bytes, { stream: true })),
  })

  const shell = process.env.SHELL || 'bash'
  // A command launches through the login shell (-l -c) so PATH/aliases/envman
  // resolve and shell quoting works; without one, a plain login shell.
  const argv = opts.cmd ? [shell, '-l', '-c', opts.cmd] : [shell]
  const proc = Bun.spawn(argv, {
    terminal,
    cwd: opts.cwd || process.env.HOME || process.cwd(),
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
  })

  proc.exited.then((code) => {
    onExit(code)
    terminal.close()
  })

  return {
    pid: proc.pid,
    onData(cb) { onData = cb },
    onExit(cb) { onExit = cb },
    write(data) { terminal.write(data) },
    resize(cols, rows) { terminal.resize(cols, rows) },
    kill() { proc.kill() },
  }
}
