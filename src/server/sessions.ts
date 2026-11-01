import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import type { AgentPermissionMode, AgentStatus } from '../shared/workspace'
import { hasClaudeHookSettings, isContextCapable, isSafeNodeId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { STALE_SWEEP_MS } from '../shared/agentStale'
import { binaryExists, spawnPty, unwrapMissingWrapper, type Pty } from './pty'
import { forgetNodeToken, hookEnv } from './hooks'
import { resumeIsDead, transcriptMissingNotice } from './transcriptPresence'
import { OutputLog } from './outputLog'
import { SubscriberSet } from './subscribers'
import { NodeRegistry, type NodeExit } from './nodeRegistry'
import { PORT, launchLine, wrapperMissingNotice } from './launchLine'

// `launchLine` dulu tinggal di file ini dan diimpor dari sini oleh test/pemanggil lama. Re-export
// menjaga kontrak itu tanpa memaksa semua pemanggil tahu file barunya.
export { launchLine }

/** Satu PTY hidup beserta jalur observasinya: log output bernomor urut dan kumpulan pelanggan. */
interface Session {
  id: string
  pty: Pty
  log: OutputLog
  subs: SubscriberSet<ServerMsg>
  exited: boolean
}

/** Ringkasan sesi hidup untuk endpoint/panel daftar. Tanpa tombstone: sesi yang sudah keluar tidak
 *  pernah muncul di sini (pakai `getExit`/`statusOf` untuk fakta sesudah mati). */
export interface SessionInfo {
  id: string
  pid: number
  status?: AgentStatus
}

/** Knob runtime yang disambungkan integrator dari store settings. Absen = default hari ini, jadi
 *  `new Sessions()` berperilaku persis seperti sebelum settings ada. */
export interface SessionsOptions {
  /** Shell untuk PTY baru. Kosong = default sistem (`settings.defaultShell`). */
  shell?: string
  /** Batas ring buffer scrollback dalam BYTE (`settings.scrollbackBytes`). */
  scrollbackBytes?: number
  /** Mode permission awal sesi claude (`settings.claudePermissionMode`). Absen = tidak ada flag
   *  `--permission-mode` sama sekali, sehingga peluncuran tetap polos selama integrator belum
   *  menyambungkan settings. */
  claudePermissionMode?: AgentPermissionMode
  /** `settings.hookReplyApprovals`. Absen/false = `NODETERM_PERM_WAIT_SECS` tidak dikirim, jadi hook
   *  permission tidak menahan apa pun — perilaku sebelum setting ini ada. */
  hookReplyApprovals?: boolean
  /** Sumber PTY. Di-inject supaya test bisa memakai PTY palsu tanpa `Bun.Terminal`. */
  spawn?: typeof spawnPty
  /** Sumber waktu untuk tombstone exit. Di-inject supaya test tidak bergantung jam dinding. */
  now?: () => number
}

export class Sessions {
  constructor(public options: SessionsOptions = {}) {}

  /** Batas scrollback efektif. Nilai settings bisa diedit tangan / datang lewat HTTP, jadi
   *  divalidasi di titik pemakaian; nilai tak masuk akal jatuh ke default. */
  private get scrollbackBytes(): number {
    const n = this.options.scrollbackBytes
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.scrollbackBytes
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private map = new Map<string, Session>()
  // Status, transcript, dan tombstone exit hidup LEBIH LAMA dari PTY-nya — makanya di registry,
  // bukan di `Session`. Node yang sudah mati tetap perlu bisa dijawab (lihat nodeRegistry.ts).
  private registry = new NodeRegistry()

  /** Tulis status lalu pancarkan ke SEMUA pelanggan sesi. Sesi tanpa pelanggan tetap menyimpan
   *  statusnya: re-attach berikutnya memutar ulang status itu sebagai snapshot. */
  setStatus(id: string, status: AgentStatus, now: number = this.now()): void {
    // Node yang sudah punya tombstone exit adalah node MATI. Hook yang telat (mis. `Stop` claude
    // mendarat sesudah shell-nya keluar) tidak boleh menghidupkan lagi statusnya — client akan
    // merender node mati itu sebagai aktif dan menawarkan Resume.
    if (this.registry.getExit(id)) return
    this.registry.setStatus(id, status, now)
    this.map.get(id)?.subs.send({ t: 'status', id, status })
  }

  /**
   * Hapus status `working` yang sudah diam melewati jendela. MENGHAPUS, bukan menggantinya dengan
   * `done`/`waiting` — alasannya di `agentStale.ts`. Self-healing: event berikutnya menulis ulang.
   */
  sweepStale(now: number = this.now()): void {
    for (const id of this.registry.sweepStale(now)) {
      // `status` absen = "tidak ada status lagi". Client menghapus entry-nya dan merender "Unknown".
      this.map.get(id)?.subs.send({ t: 'status', id })
    }
  }

  /** Nyalakan jamnya; mengembalikan penghentinya. `unref` supaya ia tidak pernah menahan proses. */
  startStaleSweep(intervalMs: number = STALE_SWEEP_MS): () => void {
    const timer = setInterval(() => this.sweepStale(), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  setTranscript(id: string, path: string): void { this.registry.setTranscript(id, path) }
  getTranscript(id: string): string | undefined { return this.registry.getTranscript(id) }
  getTerminal(id: string): string { return this.map.get(id)?.log.text() ?? '' }
  statusOf(id: string): AgentStatus | undefined { return this.registry.getStatus(id)?.status }
  isLive(id: string): boolean { return this.map.has(id) }
  getExit(id: string): NodeExit | undefined { return this.registry.getExit(id) }
  pidOf(id: string): number | undefined { return this.map.get(id)?.pty.pid }

  /** Sesi yang masih hidup, urut sesuai waktu spawn. */
  list(): SessionInfo[] {
    return [...this.map.values()].map((s) => ({
      id: s.id,
      pid: s.pty.pid,
      status: this.registry.getStatus(s.id)?.status,
    }))
  }

  /** Tambah satu pelanggan ke sesi hidup. `undefined` bila sesinya sudah tidak ada — pemanggil
   *  yang butuh snapshot bisa memutarnya lewat `open`. */
  subscribe(id: string, send: (m: ServerMsg) => void): (() => void) | undefined {
    const session = this.map.get(id)
    if (!session) return undefined
    session.subs.add(send)
    return () => { session.subs.remove(send) }
  }

  /**
   * Buka/re-attach sesi untuk sebuah intent `open`.
   *
   * BATAS INPUT: `msg.id` divalidasi dengan `isSafeNodeId` SEBELUM apa pun disentuh. Id yang tidak
   * aman DIABAIKAN — tidak ada PTY yang di-spawn, tidak ada entri `map`/status/token yang dibuat.
   * Id itu mendarat di baris perintah curl hook claude DAN jadi kunci PTY/status, jadi menolak di
   * pintu masuk membuat keduanya tidak pernah melihat nilai berbahaya (`hooks.ts` mengutip sendiri
   * sebagai lapis kedua).
   *
   * SEMUA pelanggan menerima seluruh scrollback lalu snapshot status, termasuk `send` yang sudah
   * terdaftar. Alasannya: remount meng-dispose dan membuat ulang xterm-nya, jadi buffer di sisi
   * client hilang — tanpa replay layar itu kosong. `add` idempoten, jadi tidak ada langganan ganda;
   * replay hanya dikirim ke `send`, bukan di-broadcast ke pelanggan lain.
   */
  open(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    if (!isSafeNodeId(msg.id)) return
    const existing = this.map.get(msg.id)
    if (existing) {
      const status = this.registry.getStatus(msg.id)?.status
      existing.subs.add(send)
      for (const chunk of existing.log.since(0)) {
        send({ t: 'output', id: msg.id, data: chunk.data, seq: chunk.seq })
      }
      send({ t: 'status', id: msg.id, status })
      return
    }

    // Diprobe SEKALI (filesystem), lalu dipakai dua kali: menjatuhkan `--resume` dan memberi tahu
    // pengguna. Hanya transcript yang TERBUKTI tidak ada yang menjatuhkannya — `transcriptPresence.ts`.
    const deadResume = !!msg.resume && resumeIsDead(msg.sessionId, msg.agentId)
    let cmd = launchLine(msg, PORT, {
      permissionMode: this.options.claudePermissionMode,
      resumeIsDead: deadResume,
    })
    const notices: string[] = []
    if (deadResume) notices.push(transcriptMissingNotice)
    if (cmd) {
      const unwrapped = unwrapMissingWrapper(cmd, binaryExists)
      if (unwrapped) {
        cmd = unwrapped.cmd
        // Hanya NAMA binary yang hilang yang dilaporkan — baris perintah bisa memuat argumen
        // bermuatan rahasia, jadi ia tidak pernah dicetak maupun dikirim.
        notices.push(wrapperMissingNotice(unwrapped.missing))
      }
    }
    // Dua set env var yang digerbangi TERPISAH: yang pertama dibaca skill konteks-tertaut di dalam
    // sesi agent, yang kedua dibaca perintah curl yang kita tanam lewat `--settings` (token node +
    // batas tahan hook permission). Node tanpa keduanya mewarisi env apa adanya.
    const env: Record<string, string> = {
      ...(isContextCapable(msg.agentId)
        ? { NODETERM_NODE_ID: msg.id, NODETERM_PORT: String(PORT) }
        : {}),
      ...(msg.agentId && hasClaudeHookSettings(msg.agentId)
        ? hookEnv(msg.id, { hookReplyApprovals: this.options.hookReplyApprovals })
        : {}),
    }
    const spawn = this.options.spawn ?? spawnPty
    const pty = spawn({
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      cmd,
      shell: this.options.shell,
      env: Object.keys(env).length ? env : undefined,
    })
    const session: Session = {
      id: msg.id,
      pty,
      log: new OutputLog(),
      subs: new SubscriberSet<ServerMsg>(),
      exited: false,
    }
    this.map.set(msg.id, session)
    session.subs.add(send)
    pty.onData((data) => this.emit(session, data))
    pty.onExit((code) => this.onExit(session, code))
    for (const data of notices) this.emit(session, data)

    // PTY baru = hidup baru. Tombstone exit dan status milik sesi sebelumnya dengan id yang sama
    // TIDAK boleh diwarisi: node yang di-restart akan terbaca Done lalu menggerbangi Resume.
    this.registry.clearExit(msg.id)
    this.registry.deleteStatus(msg.id)
    // Selalu dijawab, termasuk ketika yang kita tahu adalah "tidak ada status". Senyap terbaca
    // "tidak berubah" oleh client yang menyimpan salinan status lepas dari socket (restart server).
    send({ t: 'status', id: msg.id })
  }

  input(id: string, data: string): void {
    this.map.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.map.get(id)?.pty.resize(cols, rows)
  }

  /** `send` = socket PEMANGGIL close, bukan socket sesi. Opsional supaya pemanggil non-socket tetap
   *  bisa membersihkan node tanpa punya tujuan pengiriman. */
  close(id: string, send?: (m: ServerMsg) => void): void {
    // Token hook, status dan transcript terikat pada NODE, bukan pada PTY — jadi ketiganya dilepas
    // SEBELUM gerbang sesi. Agent yang keluar sendiri sudah dihapus dari `map` oleh `onExit`,
    // sehingga `close` yang menyusul tetap harus membersihkannya.
    forgetNodeToken(id)
    this.registry.deleteStatus(id)
    this.registry.deleteTranscript(id)
    const session = this.map.get(id)
    // `self` menang: proses yang terbukti keluar sendiri tidak boleh ditimpa `closed`. `closed` hanya
    // mengisi slot kosong — tombol Close pada node yang sudah keluar tidak memancarkan `exit` kedua.
    const firstClose = !this.registry.getExit(id)
    if (firstClose) this.registry.setExit(id, { code: -1, reason: 'closed', at: this.now() })
    const status: ServerMsg = { t: 'status', id }
    const exit: ServerMsg = { t: 'exit', id, code: -1, reason: 'closed' }
    session?.subs.send(status)
    if (firstClose) session?.subs.send(exit)
    // Pencabutan harus sampai ke socket PEMANGGIL juga: kasus restart tidak punya entry `map`.
    // Bila ia sudah jadi pelanggan, broadcast di atas sudah mengirimnya — jangan gandakan.
    const callerHeard = session !== undefined && send !== undefined && session.subs.has(send)
    if (!callerHeard) {
      send?.(status)
      if (firstClose) send?.(exit)
    }
    if (session) {
      session.subs.clear()
      session.exited = true
      this.map.delete(id)
    }
    // Kill SESUDAH map dihapus: `onExit` digerbangi identitas, jadi gema kematian yang kita minta
    // sendiri tidak pernah menjadi `exit` kedua.
    session?.pty.kill()
  }

  /** Socket gone: forget every subscriber but keep the PTY running so a reconnect with the same id
   *  re-attaches instead of spawning a fresh shell. */
  detach(send: (m: ServerMsg) => void): void {
    for (const session of this.map.values()) session.subs.remove(send)
  }

  /** Tambah `data` ke log (dengan cap byte) lalu pancarkan ke semua pelanggan, bernomor urut. */
  private emit(session: Session, data: string): void {
    // PTY sesekali memanggil onData dengan string kosong. OutputLog tidak memberinya seq (ia
    // mengembalikan seq terakhir), jadi memancarkannya berarti pelanggan menerima `output` dengan
    // nomor urut duplikat — no-op, tapi membingungkan deteksi gap di client.
    if (data === '') return
    const seq = session.log.append(data, this.scrollbackBytes)
    session.subs.send({ t: 'output', id: session.id, data, seq })
  }

  /** PTY keluar SENDIRI. Gerbang identitas: gema dari `close` tidak boleh menulis status/exit. */
  private onExit(session: Session, code: number): void {
    if (this.map.get(session.id) !== session || session.exited) return
    session.exited = true
    const at = this.now()
    // `done` DULU, tombstone exit sesudahnya: `setStatus` mengabaikan node yang sudah punya
    // tombstone (lihat guard di sana), jadi urutan sebaliknya membuat `done` hilang.
    this.setStatus(session.id, 'done', at)
    this.registry.setExit(session.id, { code, reason: 'self', at })
    session.subs.send({ t: 'exit', id: session.id, code, reason: 'self' })
    session.subs.clear()
    this.map.delete(session.id)
  }

  handle(msg: ClientMsg, send: (m: ServerMsg) => void): void {
    switch (msg.t) {
      case 'open': this.open(msg, send); break
      case 'input': this.input(msg.id, msg.data); break
      case 'resize': this.resize(msg.id, msg.cols, msg.rows); break
      case 'close': this.close(msg.id, send); break
    }
  }
}

export const sessions = new Sessions()
// Jamnya hidup sekali per proses, di singleton — bukan di constructor, supaya `new Sessions()` di
// test tetap bebas timer dan memilih sendiri kapan menyapu.
sessions.startStaleSweep()
