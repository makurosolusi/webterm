import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ptyEnv, resolveCwd, shellArgv } from './ptyShell'
import { locateBinary } from './loginShellPath'
import { spawnPty, type Pty } from './pty'
import { createLogger } from './logs'

const log = createLogger('pty')

/**
 * Supervisor PTY lewat tmux: sesi node hidup di server tmux milik webterm (`-L webterm`), bukan di
 * proses Bun. Proses Bun hanya memegang tmux CLIENT di dalam PTY-nya, jadi saat server webterm
 * restart yang mati hanya client itu — shell/agent di dalam sesi tetap jalan, dan boot berikutnya
 * menempel lagi (`Sessions.adoptSupervised`).
 *
 * Ditiru dari nodeterm (`~/Documents/spawn/nodeterm-web/src/core`): satu sesi tmux per node, nama
 * stabil dari node id (`tmux-naming.ts:10`), socket sendiri (`tmux-naming.ts:7`), target exact
 * `=name` karena target polos jatuh ke PREFIX match (`tmux-naming.ts:29-55`), opsi server
 * `status off` / `destroy-unattached off` (`pty-manager.ts:481-490`), env per sesi lewat `-e`
 * karena server tmux dipakai bersama dan berumur panjang (`pty-manager.ts:4918-4927`), dan close =
 * `kill-session`. Orca memakai daemon PTY buatan sendiri (`src/main/daemon`, ~630 file; AGENTS.md-nya
 * mencatat puluhan cacat kepemilikan socket) — tmux memberi hal yang sama tanpa kode itu.
 *
 * Socket SENGAJA bukan `node-terminal`: itu milik nodeterm yang mungkin sedang jalan di mesin yang
 * sama, dan sesi `nt-*` di sana bukan urusan webterm.
 */

const PREFIX = 'wt-'
const AGENT_OPT = '@webterm-agent'
const ORPHAN_OPT = '@webterm-orphan'
/** Baris history tmux per pane. Scrollback sesudah restart datang dari sini (lihat `history`). */
const HISTORY_LINES = 10000
const TMUX_TIMEOUT_MS = 5000

/** Nama sesi tmux untuk node id. HEX, bukan sanitasi: id pane split memuat `:` yang tmux tolak di
 *  nama sesi, dan sanitasi (`:` → `_`) membuat `a:p1` dan `a_p1` bertabrakan. Hex bisa dibalik. */
export function supervisedName(id: string): string {
  return PREFIX + Buffer.from(id, 'utf8').toString('hex')
}

/** Kebalikan `supervisedName`; null untuk sesi yang bukan buatan webterm. */
export function nodeIdOf(name: string): string | null {
  return /^wt-(?:[0-9a-f]{2})+$/.test(name) ? Buffer.from(name.slice(PREFIX.length), 'hex').toString('utf8') : null
}

/** tmux memotong `;` di AKHIR sebuah argumen sebagai pemisah perintah (diukur: `sh -c 'echo hi;'`
 *  jadi `echo hi`), dan `\;` di akhir sebagai `;` literal. Argumen milik pengguna di-escape supaya
 *  baris perintahnya sampai utuh. */
export function tmuxArg(arg: string): string {
  return arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg
}

/** Opsi server, dipasang ulang pada setiap create (idempoten). BUKAN lewat `-f`: file itu hanya
 *  dibaca saat server mulai, jadi server yang berumur panjang tak pernah melihat perubahannya —
 *  jebakan yang nodeterm catat sebagai MIGRATION (`pty-manager.ts:497-503`).
 *
 *  `smcup@:rmcup@`: tmux digambar di layar NORMAL xterm.js, bukan alternate screen, supaya baris
 *  yang bergulir masuk scrollback xterm.js dan wheel/seleksi bawaan tetap jalan. nodeterm memilih
 *  `mouse on` + OSC 52, tapi client webterm tidak menangani OSC 52, jadi jalur itu mematikan copy. */
const SERVER_OPTS: string[][] = [
  ['set', '-g', 'status', 'off'],
  ['set', '-g', 'history-limit', String(HISTORY_LINES)],
  ['set', '-g', 'default-terminal', 'xterm-256color'],
  ['set', '-sg', 'escape-time', '10'],
  ['set', '-g', 'destroy-unattached', 'off'],
  ['set', '-g', 'window-size', 'latest'],
  ['set', '-g', 'terminal-overrides', ',xterm*:smcup@:rmcup@'],
  ['set', '-su', 'terminal-features'],
  ['set', '-as', 'terminal-features', ',*:RGB'],
  ['set', '-as', 'terminal-features', ',*:hyperlinks'],
]

/** Env yang diwarisi pane: identitas terminal yang di jalur non-tmux datang dari env anak langsung. */
const SESSION_ENV_KEYS = ['PATH', 'LANG', 'COLORTERM', 'TERM_PROGRAM'] as const

export interface SupervisedSession {
  id: string
  cols: number
  rows: number
  agentId?: string
  orphan: boolean
  /** Baris history di atas layar; 0 = tidak ada yang perlu di-seed. */
  history: number
}

export interface SupervisedOpen {
  cols: number
  rows: number
  cwd?: string
  cmd?: string
  shell?: string
  env?: Record<string, string>
  agentId?: string
}

export class TmuxSupervisor {
  constructor(readonly socket: string, private readonly bin: string = 'tmux') {}

  /**
   * Env SETIAP pemanggilan tmux. Load-bearing untuk keamanan: proses yang pertama memanggil tmux
   * MENJADI server-nya, dan semua pane mewarisi env server itu. Tanpa filter `ptyEnv` token root
   * `WEBTERM_TOKEN` server webterm akan sampai ke setiap shell/agent. `TMUX` dibuang supaya
   * webterm yang dijalankan dari dalam tmux tidak ditolak sebagai sesi bersarang.
   */
  private env(interactive: boolean): Record<string, string> {
    const env = ptyEnv(process.env, { interactive })
    delete env.TMUX
    delete env.TMUX_PANE
    return env
  }

  private run(args: string[]): string {
    return execFileSync(this.bin, ['-L', this.socket, ...args], {
      encoding: 'utf8',
      env: this.env(false),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TMUX_TIMEOUT_MS,
    })
  }

  /** Kind of the live tmux session for `id` (`@webterm-agent`), or null when there is none. */
  holder(id: string): { agentId?: string } | null {
    try {
      // The name is read back: with no such session, display-message may still answer (empty).
      const [name, agentId] = this.run(['display-message', '-p', '-t', `=${supervisedName(id)}:`, `#{session_name}\t#{${AGENT_OPT}}`]).trim().split('\t')
      return name === supervisedName(id) ? { agentId: agentId || undefined } : null
    } catch (err) {
      // Exit 1 = no such session (or no server yet): the answer. Anything else is worth a line.
      if (exitStatus(err) !== 1) log.warn('pty.supervisor_holder_failed', 'tmux display-message failed', { ids: { nodeId: id }, code: exitStatus(err) })
      return null
    }
  }

  has(id: string): boolean {
    try {
      this.run(['has-session', '-t', `=${supervisedName(id)}`])
      return true
    } catch {
      // Exit non-nol = sesi (atau servernya) tidak ada; itulah jawabannya, bukan kegagalan.
      return false
    }
  }

  /** Sesi milik webterm di socket ini. Server belum jalan = daftar kosong. */
  list(): SupervisedSession[] {
    let out: string
    try {
      out = this.run(['list-sessions', '-F', `#{session_name}\t#{window_width}\t#{window_height}\t#{${AGENT_OPT}}\t#{${ORPHAN_OPT}}\t#{history_size}`])
    } catch {
      return [] // "no server running": belum ada satu sesi pun
    }
    const found: SupervisedSession[] = []
    for (const line of out.split('\n')) {
      const [name = '', w, h, agentId, orphan, history] = line.split('\t')
      const id = nodeIdOf(name)
      if (!id) continue
      found.push({ id, cols: Number(w) || 80, rows: Number(h) || 24, agentId: agentId || undefined, orphan: !!orphan, history: Number(history) || 0 })
    }
    return found
  }

  /** Buat sesi bila belum ada, lalu tempelkan client baru. `cmd`/`env` hanya berlaku saat create —
   *  sesi yang sudah hidup (restart) dilanjutkan apa adanya, persis `new-session -A` nodeterm. */
  open(id: string, opts: SupervisedOpen): Pty {
    if (!this.has(id)) {
      try {
        this.create(id, opts)
      } catch (err) {
        // Pesan galat tmux bisa memuat cwd pengguna; hanya kodenya yang dicatat. Attach di bawah
        // lalu gagal dan node menampilkan pesan tmux-nya sendiri, bukan diam.
        log.error('pty.supervisor_create_failed', 'tmux new-session failed', { ids: { nodeId: id }, code: (err as { status?: number }).status })
      }
    }
    return this.attach(id, opts.cols, opts.rows)
  }

  private create(id: string, opts: SupervisedOpen): void {
    const name = supervisedName(id)
    const base = this.env(!opts.cmd)
    const sessionEnv: Record<string, string> = {}
    for (const k of SESSION_ENV_KEYS) if (base[k]) sessionEnv[k] = base[k]
    Object.assign(sessionEnv, opts.env)
    const envArgs = Object.entries(sessionEnv).flatMap(([k, v]) => ['-e', tmuxArg(`${k}=${v}`)])
    const argv = shellArgv(opts.shell, opts.cmd).map(tmuxArg)
    const chain = [
      'start-server',
      ...SERVER_OPTS.flatMap((o) => [';', ...o]),
      ';', 'new-session', '-d', '-s', name, '-x', String(opts.cols), '-y', String(opts.rows),
      '-c', resolveCwd(opts.cwd), ...envArgs, ...argv,
    ]
    this.run(chain)
    // Agent id disimpan DI sesi supaya boot berikutnya tahu node mana yang butuh file header token.
    if (opts.agentId) this.run(['set-option', '-t', `=${name}:`, AGENT_OPT, opts.agentId])
  }

  /** tmux client dalam PTY Bun. Membunuh Pty ini hanya men-DETACH: server tmux bukan keturunannya. */
  attach(id: string, cols: number, rows: number): Pty {
    return spawnPty({
      cols,
      rows,
      argv: [this.bin, '-L', this.socket, 'attach-session', '-t', `=${supervisedName(id)}`],
      env: this.env(false),
    })
  }

  /** Teks pane (history + layar). `screen: false` = history saja, untuk seed scrollback sesudah
   *  restart: layarnya digambar ulang sendiri oleh tmux saat client menempel. Hanya untuk pane yang
   *  PUNYA history — tanpa history, `-E -1` dijepit tmux ke baris layar pertama (terukur). */
  capture(id: string, opts: { escapes?: boolean; screen?: boolean } = {}): string | undefined {
    const args = ['capture-pane', '-p', '-J', '-S', '-', '-t', `=${supervisedName(id)}:`]
    if (opts.escapes) args.push('-e')
    if (opts.screen === false) args.push('-E', '-1')
    try {
      return this.run(args)
    } catch {
      return undefined // sesi sudah hilang; pemanggil jatuh ke log-nya sendiri
    }
  }

  /** Tandai sesi yang node-nya tidak dikenal workspace mana pun. Tidak dibunuh: layout bisa saja
   *  belum tersimpan sesaat sebelum restart, dan membunuh agent yang masih bekerja tak bisa di-undo. */
  markOrphan(id: string, now: number = Date.now()): void {
    try {
      this.run(['set-option', '-t', `=${supervisedName(id)}:`, ORPHAN_OPT, String(now)])
    } catch {
      // Sesi keluar di antara `list` dan sini — tak ada lagi yang perlu ditandai.
    }
  }

  /** Close a node = end its session. SYNCHRONOUS (~5 ms, the cost of `has`): with an async kill an
   *  open right after close still saw the dying session, attached to it and exited (pty-207-2).
   *  nodeterm orders it the same way: kill-session before any create. */
  kill(id: string): void {
    try {
      this.run(['kill-session', '-t', `=${supervisedName(id)}`])
    } catch (err) {
      // Exit 1 = the session is already gone (exited by itself / never created): the asked-for result.
      if (exitStatus(err) !== 1) log.warn('pty.supervisor_kill_failed', 'tmux kill-session failed', { ids: { nodeId: id }, code: exitStatus(err) })
    }
  }
}

const exitStatus = (err: unknown): number | undefined => (err as { status?: number }).status

/** Socket per data dir: dua instance webterm dengan data dir berbeda (dev vs test) tidak berbagi
 *  sesi. Data dir default = `webterm` polos supaya mudah diperiksa (`tmux -L webterm ls`). */
export function supervisorSocket(dataDir: string | undefined): string {
  return dataDir ? `webterm-${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}` : 'webterm'
}

export const TMUX_MISSING_NOTICE =
  '\r\n[webterm] tmux not found: this session will end when the webterm server restarts. Install tmux (e.g. `brew install tmux`) so sessions survive.\r\n'

/** Supervisor proses ini. Mati di bawah test (`NODE_ENV=test`, di-set bun test dan vitest) dan di
 *  luar Bun: test tidak boleh menempel ke sesi tmux milik pengguna. */
export function bootSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  locate: (bin: string) => string | undefined = (bin) => locateBinary(bin, env.PATH)
): { supervisor: TmuxSupervisor | null; notice?: string } {
  if (env.NODE_ENV === 'test' || !process.versions.bun) return { supervisor: null }
  // Absolute path: the probe may find tmux only on the login shell's PATH (ops-212-4), which every
  // later tmux call (run/attach) does not search.
  const tmux = locate('tmux')
  if (!tmux) {
    log.warn('pty.supervisor_missing', 'tmux not found; sessions will not survive a server restart')
    return { supervisor: null, notice: TMUX_MISSING_NOTICE }
  }
  return { supervisor: new TmuxSupervisor(supervisorSocket(env.WEBTERM_DATA_DIR), tmux) }
}
