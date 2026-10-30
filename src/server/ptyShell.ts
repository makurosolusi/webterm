import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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

const DARWIN_DEFAULT_SHELL = '/bin/zsh'
const BASH_SHELL = '/bin/bash'
const LAST_RESORT_SHELL = 'sh'
/** Shell bergaya POSIX yang mengerti `-l` sebagai login shell. */
const LOGIN_FLAG_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'])

/** Shell yang dipakai: setting/argumen -> `$SHELL` -> `/bin/zsh` (darwin) -> `/bin/bash` -> `sh`.
 *  Kandidat yang tidak ada di disk dilewati, jadi setting basi tidak mematikan node. */
export function resolveShell(
  shell: string | undefined,
  opts: { envShell?: string; platform?: string; exists?: (bin: string) => boolean } = {}
): string {
  const { envShell = process.env.SHELL, platform = process.platform, exists = binaryExists } = opts
  const candidates = [shell?.trim(), envShell?.trim(), platform === 'darwin' ? DARWIN_DEFAULT_SHELL : '', BASH_SHELL]
  return candidates.find((c): c is string => !!c && exists(c)) ?? LAST_RESORT_SHELL
}

/** argv untuk shell. Perintah diluncurkan lewat login shell (`-l -c`) supaya PATH/alias resolve dan
 *  quoting shell berlaku; tanpa perintah, shell interaktif biasa juga login (`-l`) seperti Terminal.app. */
export function shellArgv(shell?: string, cmd?: string, opts?: Parameters<typeof resolveShell>[1]): string[] {
  const bin = resolveShell(shell, opts)
  if (cmd) return [bin, '-l', '-c', cmd]
  return LOGIN_FLAG_SHELLS.has(basename(bin).replace(/^-/, '')) ? [bin, '-l'] : [bin]
}

/** cwd efektif: `~` / `~/x` di-expand ke home; kosong, tidak ada, atau bukan direktori jatuh ke home. */
export function resolveCwd(
  cwd: string | undefined,
  home: string = process.env.HOME || homedir(),
  isDir: (p: string) => boolean = (p) => {
    try { return statSync(p).isDirectory() } catch { return false }
  }
): string {
  const raw = cwd?.trim()
  if (!raw) return home
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  return isDir(expanded) ? expanded : home
}

/** Variabel proses server tanpa konsumen di dalam PTY. `BUN_INSTALL` dikecualikan: rc user sering
 *  merujuknya untuk PATH. `WEBTERM_*` dan `NODETERM_*` sengaja tetap (hooks + shim context-link). */
const LEAKED_ENV = /^(NODE_ENV|PORT|HOST|VITE_.*|BUN_(?!INSTALL$).*)$/

/** Env anak. `TERM` LOAD-BEARING: bentuk inline `terminal` tidak menerima `name`, jadi env inilah
 *  satu-satunya yang memberi tahu program di dalam PTY tipe terminalnya (tanpa itu `dumb`).
 *  `interactive` (shell biasa, tanpa `cmd`) menambah identitas terminal; jalur agent tak disentuh. */
export function ptyEnv(
  source: NodeJS.ProcessEnv,
  opts: { interactive: boolean; platform?: string }
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !LEAKED_ENV.test(k)) env[k] = v
  env.TERM = 'xterm-256color'
  if (opts.interactive) {
    env.TERM_PROGRAM = 'webterm'
    env.COLORTERM = 'truecolor'
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
      env.LANG = (opts.platform ?? process.platform) === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
    }
  }
  return env
}
