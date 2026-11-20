import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { customBinPath, withCustomBin } from './customBinPath'
import { refreshOnMiss } from './pathResolver'
import { getDotenvBoot, PTY_KEEP_FROM_DOTENV } from './dotenvFiles'
import { createLogger } from './logs'

const log = createLogger('pty')
// Path shell hilang yang sudah diwarn. Tanpa ini setiap spawn node baru mengulang warn yang sama
// selama setting basi belum dibetulkan, dan log penuh satu pesan.
const warnedMissing = new Set<string>()

/** Apakah `bin` bisa dieksekusi — path langsung bila mengandung `/`, selain itu dicari di PATH.
 *  Hanya cek keberadaan + bit executable: TIDAK pernah menjalankan binary-nya.
 *
 *  LIMIT: this reads the SERVER PROCESS PATH. At boot the login shell's PATH is merged into it
 *  (`mergeLoginShellPath`, run from index.ts), so nvm/asdf/Homebrew entries set by rc files are
 *  included; what can still differ is a PATH change made after boot or by a shell other than
 *  `$SHELL`. So a negative result is only used
 *  to DROP a wrapper (see `unwrapMissingWrapper`), never to refuse a launch: the worst wrong guess
 *  ignores one wrapper and says so, it does not kill the node. */
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
  const onPath = (p: string): boolean => p.split(':').some((dir) => dir && executable(join(dir, bin)))
  if (onPath(pathEnv)) return true
  // A miss on the server's own PATH is not trusted: the tool may have been installed after boot
  // (pathResolver rescans the usual dirs and the user's extra dirs, rate limited per name).
  return pathEnv === process.env.PATH && refreshOnMiss(bin) && onPath(process.env.PATH ?? '')
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
  const chosen = candidates.find((c): c is string => !!c && exists(c)) ?? LAST_RESORT_SHELL
  // Hanya kandidat SEBELUM yang terpilih: itu yang benar-benar dilewati. Path shell bukan PII.
  const at = candidates.indexOf(chosen)
  for (const c of candidates.slice(0, at < 0 ? candidates.length : at)) {
    if (!c || warnedMissing.has(c)) continue
    warnedMissing.add(c)
    log.warn('pty.shell_missing', 'Configured shell not found, using fallback', { shell: c, fallback: chosen })
  }
  return chosen
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
 *  merujuknya untuk PATH.
 *
 *  `WEBTERM_*` dan `NODETERM_*` (legacy: prefiks sebelum rename, boleh dihapus setelah 0.10.0) ikut DIBUANG, bukan diteruskan apa adanya: `WEBTERM_TOKEN` di proses
 *  server adalah token ROOT (satu-satunya pembuka API manusia), dan mewariskannya ke shell/agent mana
 *  pun membuat setiap anak memegang kunci penuh. Nilai yang memang dibutuhkan sebuah node di-inject
 *  eksplisit oleh pemanggil sesudah filter ini (lihat env `open` di `sessions.ts`): token node untuk
 *  agent, `WEBTERM_NODE_ID`/`WEBTERM_PORT` untuk sesi context-capable.
 *
 *  `TELEGRAM_BOT_TOKEN` disapu tanpa syarat: bot token tak punya konsumen di shell/agent.
 *  Kredensial provider (`ANTHROPIC_API_KEY`/`AUTH_TOKEN`/`CUSTOM_HEADERS`) dan SCRUB juga disapu: hanya credential
 *  proxy memegang kunci; anak Claude diberi placeholder oleh launch file. Ini menutup bocor lewat server tmux. */
const LEAKED_ENV = /^(NODE_ENV|PORT|HOST|VITE_.*|BUN_(?!INSTALL$).*|WEBTERM_.*|NODETERM_.*|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)$/

/** Env anak. `TERM` LOAD-BEARING: bentuk inline `terminal` tidak menerima `name`, jadi env inilah
 *  satu-satunya yang memberi tahu program di dalam PTY tipe terminalnya (tanpa itu `dumb`).
 *  `interactive` (shell biasa, tanpa `cmd`) menambah identitas terminal; jalur agent tak disentuh.
 *  `strip` = kunci asal `.env` (provenance boot): disapu, kecuali yang `keep` (kunci provider + OS). */
export function ptyEnv(
  source: NodeJS.ProcessEnv,
  opts: { interactive: boolean; platform?: string; strip?: ReadonlySet<string>; keep?: (key: string) => boolean }
): Record<string, string> {
  const { strip = getDotenvBoot().keys, keep = PTY_KEEP_FROM_DOTENV } = opts
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && !LEAKED_ENV.test(k) && !(strip.has(k) && !keep(k))) env[k] = v
  }
  env.TERM = 'xterm-256color'
  // Managed custom commands (customBinPath): first on PATH for every shell and launcher. Login shells
  // keep inherited entries (path_helper reorders but does not drop them), so it survives `-l`.
  env.PATH = withCustomBin(env.PATH, customBinPath(source))
  if (opts.interactive) {
    env.TERM_PROGRAM = 'webterm'
    env.COLORTERM = 'truecolor'
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
      env.LANG = (opts.platform ?? process.platform) === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
    }
  }
  return env
}
