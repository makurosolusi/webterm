import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

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

/** Apakah `bin` bisa dieksekusi — path langsung bila mengandung `/`, selain itu dicari di PATH.
 *  Hanya cek keberadaan + bit executable: TIDAK pernah menjalankan binary-nya.
 *
 *  BATASNYA: yang dibaca PATH PROSES SERVER, sedangkan perintah berjalan di login shell yang
 *  mungkin punya PATH lebih luas (nvm/asdf/homebrew lewat rc) — jebakan yang nodeterm juga catat di
 *  `pty-manager.ts`. Karena itu hasil negatif hanya dipakai untuk MEMBUANG pembungkus (lihat
 *  `unwrapMissingWrapper`), bukan untuk menolak peluncuran: salah tebak paling buruk mengabaikan
 *  satu pembungkus dan mengatakannya, bukan mematikan node. */
export function binaryExists(bin: string, pathEnv = process.env.PATH ?? ''): boolean {
  const executable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      // Tidak ada / tidak executable / tidak boleh dibaca — ketiganya berarti "tak bisa dipakai".
      return false
    }
  }
  if (bin.includes('/')) return executable(bin)
  return pathEnv.split(':').some((dir) => dir && executable(join(dir, bin)))
}

/** Nama binary yang (mungkin) dipakai sebuah baris perintah: token pertama, hanya bila ia nama
 *  binary POLOS. Mengembalikan null untuk apa pun yang butuh interpretasi shell — prefix assignment
 *  env (`FOO=1 claude`), quoting, substitusi, pipe — karena di situ token pertama bukan program. */
function leadingBinary(cmd: string): string | null {
  const bin = cmd.trim().split(/\s+/)[0] ?? ''
  if (!bin) return null
  return /^[\w.\-/]+$/.test(bin) ? bin : null
}

/** Pemisah yang dipakai pembungkus perintah untuk menyerahkan argv ke program yang dibungkus. */
const WRAPPER_SEP = ' -- '

/**
 * Membuang pembungkus perintah yang binary-nya TIDAK terpasang, mis. `envman -e p -- claude` →
 * `claude` ketika `envman` tidak ada di PATH. Mengembalikan null bila tidak ada yang perlu dibuang.
 *
 * KENAPA ADA: `assembleCmd` (`src/shared/workspace.ts`) membungkus perintah agent dengan `envman`
 * bila sebuah profil dipilih. envman adalah invensi webterm — ia TIDAK ada di nodeterm (diverifikasi:
 * nol kemunculan di source v0.4.5) — jadi pada mesin tanpa envman setiap node agent mati dengan
 * `load envman: no such file or directory`. Degradasi di sini membuat node tetap berguna.
 *
 * Pembongkaran hanya terjadi saat ADA pemisah `--`: tanpa itu kita tidak tahu di mana perintah yang
 * dibungkus mulai, dan menebak berarti menjalankan sesuatu yang tidak diminta pengguna.
 */
export function unwrapMissingWrapper(
  cmd: string,
  exists: (bin: string) => boolean = binaryExists
): { cmd: string; missing: string } | null {
  let rest = cmd.trim()
  let missing = ''
  for (;;) {
    const bin = leadingBinary(rest)
    if (!bin || exists(bin)) break
    const sep = rest.indexOf(WRAPPER_SEP)
    if (sep < 0) break // program utama yang hilang, bukan pembungkus — biarkan shell yang melapor
    if (!missing) missing = bin // pembungkus terluar = yang dilaporkan ke pengguna
    rest = rest.slice(sep + WRAPPER_SEP.length).trim()
  }
  return missing ? { cmd: rest, missing } : null
}

/** argv untuk login shell. `shell` kosong/absen = default sistem, persis arti `settings.defaultShell`.
 *  Sebuah perintah diluncurkan lewat login shell (`-l -c`) supaya PATH/alias resolve dan quoting
 *  shell berlaku; tanpa perintah, login shell biasa. */
export function shellArgv(shell?: string, cmd?: string): string[] {
  const bin = shell?.trim() || process.env.SHELL || 'bash'
  return cmd ? [bin, '-l', '-c', cmd] : [bin]
}

export function spawnPty(opts: { cols: number; rows: number; cwd?: string; cmd?: string; shell?: string; env?: Record<string, string> }): Pty {
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

  const proc = Bun.spawn(shellArgv(opts.shell, opts.cmd), {
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
