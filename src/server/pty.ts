import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

/**
 * Pembungkus PTY Bun-native: POSIX spawn node-pty rusak di bawah Bun, jadi PTY-nya datang dari
 * `Bun.spawn({ terminal })` (diverifikasi pada Bun 1.4.2).
 *
 * KENAPA bentuk INLINE `terminal: { cols, rows, data }` dan BUKAN objek `new Bun.Terminal(...)`:
 * keduanya memberi PTY yang bisa dibaca-tulis, tapi hanya bentuk inline yang membuat Bun memanggil
 * setsid + TIOCSCTTY, sehingga PTY itu benar-benar jadi CONTROLLING TERMINAL anaknya. Tanpa itu
 * tty-nya tak punya foreground process group (`ps -o tpgid` → 0) dan kernel tak punya siapa pun
 * untuk disinyali: line discipline menerima `\x03` tapi SIGINT tak pernah terkirim (Ctrl+C tak
 * mengeluarkan htop), dan `resize` memperbarui winsize tanpa ada yang menerima SIGWINCH (TUI
 * full-screen tak menggambar ulang). Diukur berdampingan pada Bun 1.4.2 — bentuk objek: tpgid 0,
 * proses foreground selamat dari `\x03`; bentuk inline: tpgid = pid anak, tty sendiri, proses
 * foreground mati. Isu upstream yang mencatat bentuk objek: oven-sh/bun#33237.
 *
 * Global Bun ditipekan lokal dengan sengaja: @types/bun mengirim override global `fetch` yang
 * memerahkan file-file tak terkait, jadi hanya irisan yang dipakai di sini yang dideklarasikan.
 */
declare namespace Bun {
  interface Terminal { write(data: string): void; resize(cols: number, rows: number): void }
  interface TerminalOptions { cols?: number; rows?: number; data: (terminal: Terminal, bytes: Uint8Array) => void }
  interface Subprocess { readonly pid: number; readonly terminal: Terminal; readonly exited: Promise<number>; kill(signal?: number): void }
}
declare const Bun: {
  spawn(cmd: string[], options: { terminal: Bun.TerminalOptions; cwd?: string; env?: Record<string, string> }): Bun.Subprocess
}

export interface Pty {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Env anak. `TERM` di sini LOAD-BEARING, bukan kerapian: bentuk inline `terminal` tidak menerima
 *  `name` seperti konstruktor `Bun.Terminal` dulu, jadi env inilah satu-satunya yang memberi tahu
 *  program di dalam PTY tipe terminalnya. Dibiarkan jatuh ke `dumb` berarti warna dan TUI mati di
 *  seluruh aplikasi. (Diukur dari dalam PTY sesudah pindah ke bentuk inline: `$TERM` = xterm-256color.) */
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

/** Jeda SIGTERM → SIGKILL saat node ditutup. Meniru grace nodeterm (`pty-manager.ts:7099-7110`,
 *  30 × 50 ms): beri harness agent jendela untuk menulis transcript/resume id sebelum dipaksa. */
const KILL_GRACE_MS = 1500

/** Keturunan `pid` dari satu snapshot `ps`. Dipisah dari I/O supaya bisa diuji tanpa men-spawn
 *  apa pun (lihat `pty.test.ts`). */
export function descendantPids(pid: number, psOutput: string): number[] {
  const kids = new Map<number, number[]>()
  for (const line of psOutput.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
    kids.set(parent as number, [...(kids.get(parent as number) ?? []), child as number])
  }
  const found: number[] = []
  const walk = (parent: number): void => {
    for (const child of kids.get(parent) ?? []) {
      // Pid yang sudah terdaftar dilewati supaya penelusuran pasti berhenti walau snapshot `ps`
      // sempat memberi baris yang bertabrakan (pid daur ulang), bukan karena pohon proses bersiklus.
      if (child === pid || found.includes(child)) continue
      found.push(child)
      walk(child)
    }
  }
  walk(pid)
  return found
}

/** Keturunan hidup `pid`. Pid server sendiri dibuang sebagai jaring pengaman: tak ada pohon nyata
 *  yang menaruhnya di bawah anak kita, dan satu baris `ps` yang salah baca tidak boleh berujung
 *  server menyinyal dirinya sendiri. */
function liveDescendants(pid: number): number[] {
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    return descendantPids(pid, ps).filter((p) => p > 1 && p !== process.pid)
  } catch {
    // `ps` absen/gagal: kehilangan sweep lebih baik daripada menebak pid. Perilaku lama (sinyal ke
    // pid anak saja) tetap berlaku.
    return []
  }
}

/** Sinyal ke tiap pid, mengabaikan yang sudah keluar. */
function signalAll(pids: number[], signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Daftar pid-nya SELALU satu snapshot `ps` yang sudah basi beberapa milidetik saat dipakai,
      // jadi ESRCH di sini normal, bukan anomali — dan untuk SIGTERM/SIGKILL proses yang sudah mati
      // justru hasil yang diminta, jadi tak ada pemanggil yang bisa menindaklanjutinya.
    }
  }
}

/** Winsize yang masuk akal. Bukan paranoia tipe: `resize` datang lewat WebSocket dari `fit()` di
 *  client, dan `fit()` pada elemen 0x0 (node yang dilipat / belum ter-layout) bisa memberi 0 atau
 *  NaN. Nol tak berarti bagi termios, dan NaN LOLOS gerbang perubahan di bawah karena `NaN !== NaN`
 *  — artinya setiap detak ResizeObserver akan menulis ulang termios dan memicu satu SIGWINCH dari
 *  kernel, yaitu satu redraw penuh TUI per detak. */
const saneWinsize = (n: number): boolean => Number.isInteger(n) && n > 0

export function spawnPty(opts: { cols: number; rows: number; cwd?: string; cmd?: string; shell?: string; env?: Record<string, string> }): Pty {
  let onData: (data: string) => void = () => {}
  let onExit: (code: number) => void = () => {}
  // Streaming decoder so a multi-byte UTF-8 rune split across two read chunks
  // is not mangled into replacement characters.
  const decoder = new TextDecoder('utf-8')

  // Bentuk inline — lihat komentar bentuk spawn di kepala file. PTY-nya diakses lewat
  // `proc.terminal`, bukan objek yang kita pegang sendiri.
  const proc = Bun.spawn(shellArgv(opts.shell, opts.cmd), {
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data: (_t, bytes) => onData(decoder.decode(bytes, { stream: true })),
    },
    cwd: opts.cwd || process.env.HOME || process.cwd(),
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
  })
  const terminal = proc.terminal

  /**
   * TIDAK ada `terminal.close()` di sini, dan itu DISENGAJA — bentuk inline membuat PTY-nya milik
   * Bun, dan Bun menutup master-nya sendiri saat `Subprocess`-nya dikumpulkan GC. Diukur pada Bun
   * 1.4.2: 60 PTY yang keluar sendiri meninggalkan 56 fd ptmx terbuka, lalu 2 sesudah `Bun.gc(true)`
   * — jadi fd-nya tertunda sampai GC, bukan bocor.
   *
   * Menutupnya sendiri justru MERUSAK: close kita + close milik Bun saat GC adalah DOUBLE CLOSE, dan
   * close kedua mendarat kapan saja nanti — menutup nomor fd yang saat itu sudah dipegang PTY yang
   * LEBIH BARU. PTY baru itu lalu diam total, dan sekali satu rusak, spawn-spawn sesudahnya ikut
   * rusak. Diukur: dengan close eksplisit 2/25 putaran diam, tanpa close 0/25 pada tiga kali
   * pengulangan (probe: spawn `exit 0`, tunggu exit, lalu spawn PTY baru dan tunggu outputnya).
   */
  proc.exited.then((code) => {
    onExit(code)
  })

  // Winsize yang TERAKHIR benar-benar dipasang ke termios. Gerbangnya hidup di sini, bukan di
  // `Sessions`, karena PTY-lah yang memang tahu nilai ini — `Sessions.resize` hanya meneruskan.
  let lastCols = opts.cols
  let lastRows = opts.rows

  return {
    pid: proc.pid,
    onData(cb) { onData = cb },
    onExit(cb) { onExit = cb },
    write(data) { terminal.write(data) },
    /**
     * SIGWINCH TIDAK dikirim dari sini: PTY ini controlling terminal anaknya, jadi `terminal.resize()`
     * (TIOCSWINSZ) membuat KERNEL menyinyali foreground process group — termasuk pemegang layar yang
     * merupakan keturunan, karena `cmd` dijalankan lewat login shell (`shellArgv`) sehingga `claude`
     * adalah cucu dan satu grup dengannya. Diukur dari dalam PTY: `stty size` ikut berubah DAN trap
     * WINCH di cucu jalan tanpa fan-out apa pun dari sisi server.
     */
    resize(cols, rows) {
      if (!saneWinsize(cols) || !saneWinsize(rows)) return
      // Gerbang perubahan. `TerminalCore` mengirim `resize` pada SETIAP detak ResizeObserver, dan
      // sekarang setiap resize yang lolos berarti satu redraw penuh TUI. SENGAJA tanpa debounce —
      // cukup gerbang kesetaraan, karena `fit()` memetakan piksel ke sel, jadi ukuran baru hanya
      // muncul saat seretan melewati batas sel (puluhan kali per seretan, bukan per frame). Debounce
      // di sisi server justru akan menahan resize TERAKHIR dan meninggalkan node yang berhenti
      // diseret pada ukuran yang salah.
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      terminal.resize(cols, rows)
    },
    /**
     * KENAPA tetap mendaftar keturunan lewat `ps` dan BUKAN `process.kill(-pid)`, padahal bentuk
     * inline memang membuat anak jadi session leader dengan pgid = pid-nya sendiri (terukur): varian
     * process-group sudah dicoba dan DIUKUR LEBIH BURUK. Dengan `kill(-pid)` suite penuh jadi
     * intermiten — PTY yang baru di-spawn kadang tidak mengeluarkan output sama sekali lalu
     * spawn-spawn sesudahnya ikut rusak (8 putaran: bentuk daftar-keturunan 0 putaran bermasalah,
     * bentuk grup 3-4). Sinyal grupnya juga terbukti KELUAR dari pohon kita sendiri: log sinyal
     * mencatat `kill(-pid, SIGTERM)` membalas EPERM pada 3 dari 6 putaran — kernel mengatakan grup
     * itu bukan milik kita, padahal pid-nya baru saja kita spawn. Akar persisnya belum terjelaskan,
     * jadi ini BUKAN klaim "grup salah dihitung"; yang pasti hanya bahwa jalur grup menembak sesuatu
     * di luar pohon ini, dan jalur `ps` tidak. Daftar pid eksplisit hanya menyinyal pid yang sudah
     * diverifikasi keturunan, jadi salah tebak paling buruk KEHILANGAN satu sweep, bukan membunuh
     * proses milik orang lain.
     *
     * Daftar dikumpulkan SEBELUM shell mati: sesudahnya cucu di-reparent ke pid 1 dan `ps` tak lagi
     * bisa menghubungkannya ke node ini.
     *
     * Grace SIGTERM → SIGKILL tetap ada: yang mengabaikan SIGTERM dipaksa sesudahnya, karena cucu
     * yang lolos terus memakai CPU — dan untuk node agent, terus memakan token.
     */
    kill() {
      const strays = liveDescendants(proc.pid)
      proc.kill()
      signalAll(strays, 'SIGTERM')
      setTimeout(() => signalAll([proc.pid, ...strays], 'SIGKILL'), KILL_GRACE_MS)
    },
  }
}
