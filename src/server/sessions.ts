import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import type { AgentPermissionMode, AgentStatus } from '../shared/workspace'
import {
  canResumeWith,
  hasClaudeHookSettings,
  isContextCapable,
  isSafeSessionId,
  resumeCommandWith,
  withSessionId,
} from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { STALE_SWEEP_MS, isStaleWorking } from '../shared/agentStale'
import { binaryExists, spawnPty, unwrapMissingWrapper, type Pty } from './pty'
import { buildClaudeFlags, forgetNodeToken, hookEnv } from './hooks'
import { resumeIsDead, transcriptMissingNotice } from './transcriptPresence'

const PORT = Number(process.env.PORT) || 8700

interface Session {
  id: string
  pty: Pty
  buffer: string[]
  bytes: number
  send?: (m: ServerMsg) => void
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
}

/** Catatan peluncuran yang terlihat pengguna, ditulis ke stream terminal. Bahasa Inggris supaya
 *  seragam dengan `[process exited]` di client. */
const wrapperMissingNotice = (bin: string): string =>
  `\r\n[webterm] '${bin}' is not installed — launching the agent command without that wrapper.\r\n`

/**
 * Baris peluncuran final untuk sebuah intent open: perintah dasar client plus flag session-id /
 * resume sesuai grammar agent-nya. Murni (tanpa PTY) supaya perakitan flag bisa dites langsung.
 *
 * Grammar TIDAK dirakit di sini — ia milik `src/shared/workspace.ts` (`withSessionId`,
 * `resumeCommandWith`), karena bentuknya beda per harness: `copilot` memakai `--session-id=<sid>`
 * dan `cursor` sama sekali tidak punya flag itu (ia mengadopsi id lewat `--resume <uuid-baru>`).
 *
 * CATATAN RISIKO (beda dari nodeterm, sengaja): nodeterm menggerbangi minting session id di balik
 * probe versi CLI per agent (`supportsSessionIdFlag`, yang menyelidiki `claude --version` dan
 * `grok --help` terpisah — diverifikasi di source v0.4.5). webterm tidak memprobe sama sekali dan
 * memakai `SESSION_ID_CAPABLE` apa adanya. Risikonya terbatas: CLI lama menolak flag di peluncuran
 * PERTAMA, bukan merusak state. Kalau muncul di lapangan, tambahkan probe-nya — jangan diam-diam
 * mengecilkan daftar kapabilitas.
 */
export function launchLine(
  msg: OpenMsg,
  port = PORT,
  opts?: { permissionMode?: AgentPermissionMode; resumeIsDead?: boolean }
): string | undefined {
  const cmd = msg.cmd
  if (!cmd) return undefined
  const agentId = msg.agentId
  const sid = msg.sessionId?.trim()
  // Transcript yang sudah hilang = resume yang membunuh node di peluncuran; keputusannya diprobe
  // oleh pemanggil (fungsi ini tetap murni) — alasan lengkapnya di `transcriptPresence.ts`.
  const resume = !!msg.resume && !opts?.resumeIsDead
  // Session id mendarat di baris perintah shell dan datang lewat WebSocket, jadi divalidasi ulang
  // di sini — batas input, bukan sekadar janji tipe.
  if (!agentId || !sid || !isSafeSessionId(sid, true)) return cmd

  // `buildClaudeFlags` memancarkan flag id claude, `--permission-mode` dan `--settings` sebagai satu
  // unit, dan ketiganya grammar claude — jadi gerbangnya daftar kapabilitas, bukan nama agent.
  // `--settings` membawa PATH file settings yang baru ditulis, bukan blob JSON inline (alasannya di
  // `writeClaudeSettings`, hooks.ts) — jadi peluncuran ini menyentuh disk, bukan sekadar merakit string.
  if (hasClaudeHookSettings(agentId)) {
    return `${cmd} ${buildClaudeFlags(msg.id, sid, port, resume, {
      permissionMode: opts?.permissionMode,
    })}`
  }
  if (resume) {
    // Perintah client dipakai utuh sebagai program, jadi pembungkus apa pun tetap terpasang.
    return canResumeWith(agentId, sid) ? resumeCommandWith(cmd, agentId, sid) ?? cmd : cmd
  }
  return withSessionId(cmd, agentId, sid)
}

export class Sessions {
  constructor(public options: SessionsOptions = {}) {}

  /** Batas scrollback efektif. Nilai settings bisa diedit tangan / datang lewat HTTP, jadi
   *  divalidasi di titik pemakaian; nilai tak masuk akal jatuh ke default. */
  private get scrollbackBytes(): number {
    const n = this.options.scrollbackBytes
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.scrollbackBytes
  }

  private map = new Map<string, Session>()
  // Status MEMBAWA WAKTU. Tanpa itu tidak ada yang bisa membedakan `working` yang masih berjalan
  // dari `working` yang ditinggal mati, dan status terakhir bertahan selamanya (lihat `agentStale`).
  private status = new Map<string, { status: AgentStatus; updatedAt: number }>()
  // Hook-fed claude transcript path per node, for context-link reads.
  private transcripts = new Map<string, string>()

  /** `now` di-inject supaya sapuan bisa dites tanpa menunggu 20 menit; pemanggil nyata melewatkannya. */
  setStatus(id: string, status: AgentStatus, now: number = Date.now()): void {
    // Jamnya dimundurkan pada SETIAP penulisan, termasuk `working` yang berulang — itulah yang
    // membuat turn panjang yang sah tidak pernah tersapu: tiap tool call menulis ulang `working`.
    this.status.set(id, { status, updatedAt: now })
    this.map.get(id)?.send?.({ t: 'status', id, status })
  }

  /**
   * Hapus status `working` yang sudah diam melewati jendela. MENGHAPUS, bukan menggantinya dengan
   * `done`/`waiting` — alasannya di `agentStale.ts`. Self-healing: event berikutnya menulis ulang.
   */
  sweepStale(now: number = Date.now()): void {
    for (const [id, entry] of this.status) {
      if (!isStaleWorking(entry.status, entry.updatedAt, now)) continue
      this.status.delete(id)
      // `status` absen = "tidak ada status lagi". Client menghapus entry-nya dan merender "Unknown".
      this.map.get(id)?.send?.({ t: 'status', id })
    }
  }

  /** Nyalakan jamnya; mengembalikan penghentinya. `unref` supaya ia tidak pernah menahan proses. */
  startStaleSweep(intervalMs: number = STALE_SWEEP_MS): () => void {
    const timer = setInterval(() => this.sweepStale(), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  setTranscript(id: string, path: string): void { this.transcripts.set(id, path) }
  getTranscript(id: string): string | undefined { return this.transcripts.get(id) }
  getTerminal(id: string): string { return this.map.get(id)?.buffer.join('') ?? '' }

  open(msg: OpenMsg, send: (m: ServerMsg) => void): void {
    const existing = this.map.get(msg.id)
    if (existing) {
      // PTY survived the previous socket — re-attach and replay scrollback.
      existing.send = send
      for (const chunk of existing.buffer) send({ t: 'output', id: msg.id, data: chunk })
      // SELALU dijawab, termasuk ketika yang kita tahu adalah "tidak ada status". Senyap itu
      // ambigu: client MENYIMPAN salinan status (`statuses` di `client/ws.ts` adalah map modul,
      // bertahan melewati putus-sambung socket), jadi tidak mengirim apa pun terbaca "tidak ada
      // perubahan", bukan "tidak ada status". Node yang disapu selagi socket-nya pergi kehilangan
      // pencabutannya — sapuan memancarkannya ke `send` yang sudah `undefined` lewat `detach` —
      // dan tanpa cabang ini salinan 'working' di browser bertahan selamanya: persis gejala yang
      // mau dibunuh jam basi, lewat pintu lain. Re-attach adalah momen sinkronisasi.
      send({ t: 'status', id: msg.id, status: this.status.get(msg.id)?.status })
      return
    }

    // Diprobe SEKALI (filesystem), lalu dipakai dua kali: menjatuhkan `--resume` dan memberi tahu
    // pengguna. Hanya transcript yang TERBUKTI tidak ada yang menjatuhkannya — `transcriptPresence.ts`.
    const deadResume = !!msg.resume && resumeIsDead(msg.sessionId, msg.agentId)
    let cmd = launchLine(msg, PORT, {
      permissionMode: this.options.claudePermissionMode,
      resumeIsDead: deadResume,
    })
    if (deadResume) send({ t: 'output', id: msg.id, data: transcriptMissingNotice })
    if (cmd) {
      const unwrapped = unwrapMissingWrapper(cmd, binaryExists)
      if (unwrapped) {
        cmd = unwrapped.cmd
        // Hanya NAMA binary yang hilang yang dilaporkan — baris perintah bisa memuat argumen
        // bermuatan rahasia, jadi ia tidak pernah dicetak maupun dikirim.
        send({ t: 'output', id: msg.id, data: wrapperMissingNotice(unwrapped.missing) })
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
    const pty = spawnPty({
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      cmd,
      shell: this.options.shell,
      env: Object.keys(env).length ? env : undefined,
    })
    const session: Session = { id: msg.id, pty, buffer: [], bytes: 0, send }
    this.map.set(msg.id, session)

    // Scrollback disimpan per sesi supaya socket yang re-attach bisa memutar ulang yang terlewat.
    // Satuannya BYTE (lihat doc `settings.scrollbackBytes`), jadi dihitung sebagai byte UTF-8 —
    // bukan `.length`, yang menghitung unit UTF-16 dan memberi batas ~2x lebih longgar untuk
    // output non-ASCII (box-drawing TUI agent persisnya).
    pty.onData((data) => {
      session.buffer.push(data)
      session.bytes += Buffer.byteLength(data)
      // Dibaca per chunk, bukan sekali saat open: perubahan settings ikut berlaku untuk sesi hidup.
      while (session.bytes > this.scrollbackBytes && session.buffer.length > 1) {
        session.bytes -= Buffer.byteLength(session.buffer.shift()!)
      }
      session.send?.({ t: 'output', id: session.id, data })
    })
    pty.onExit((code) => {
      // Sesi ini sudah tidak terdaftar = `close` yang membunuhnya, jadi exit ini gema dari kematian
      // yang KITA minta. Digerbangi SEBELUM `exit` dipancarkan, bukan hanya sebelum status: client
      // mencocokkan `exit` BY ID (`ws.ts`), jadi "New session" — `close` lalu remount id yang sama
      // seketika — menyuapkan `[process exited]` PTY mati ke terminal yang baru lahir. Dan ia tidak
      // boleh menulis 'done' atas nama node (menghidupkan ulang status yang baru dicabut, dan
      // menggerbangi Resume di atas klaim mati) maupun menghapus sesi PENGGANTI ber-id sama.
      if (this.map.get(session.id) !== session) return
      session.send?.({ t: 'exit', id: session.id, code })
      this.setStatus(session.id, 'done')
      this.map.delete(session.id)
    })

    // SENGAJA TIDAK ADA status awal di sini. Dulu baris ini `setStatus(msg.id, 'working')` untuk
    // setiap sesi ber-agentId, padahal yang baru terjadi hanyalah PTY-nya lahir: CLI-nya masih
    // memuat banner dan belum diberi satu pun prompt. Itu klaim tanpa bukti, dan ia yang membuat
    // node agent yang baru dibuka terbaca RUNNING serta ikut terhitung di seksi Running sidebar.
    // Status pertama sekarang datang dari sinyal nyata — hook claude (`hookStatus`) atau `onExit`.
    //
    // Konsekuensi yang diterima: agent yang BELUM punya pemasok status di webterm (semua selain
    // claude — hanya `CLAUDE_HOOK_SETTINGS_CAPABLE` yang dipasangi hook) kini duduk di "Unknown"
    // sampai prosesnya keluar. Itu memang keadaan pengetahuan kita yang sebenarnya; obatnya
    // memasang pemasok status untuk harness lain (nodeterm punya normalizer codex/gemini sendiri),
    // bukan menebak "working" untuk semua.
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
    // SEBELUM gerbang sesi hidup di bawah. Sebuah agent yang prosesnya keluar sendiri sudah dihapus
    // dari `map` oleh `onExit`, sehingga `close` yang menyusul akan return lebih awal: token tetap
    // sah selamanya, dan sesi berikutnya dengan node id yang sama mewarisi 'done' serta path
    // transcript milik sesi mati itu. Itulah jalur restart — CLI-nya selalu keluar lebih dulu.
    forgetNodeToken(id)
    this.status.delete(id)
    this.transcripts.delete(id)
    // Pencabutannya memang harus lewat socket PEMANGGIL: kasus di atas justru tidak punya entry di
    // `map`, jadi tidak ada `session.send` untuk dicapai. Tanpa pesan ini salinan status di client
    // (map modul di `client/ws.ts`, bertahan lepas dari mount) tidak pernah tercabut dan node yang
    // baru di-restart tetap terbaca Done. `status` absen = "tidak ada status lagi" — tidak ada nilai
    // yang dikarang, khususnya bukan 'done' yang menggerbangi Resume/Restart.
    send?.({ t: 'status', id })
    const session = this.map.get(id)
    if (!session) return
    session.pty.kill()
    this.map.delete(id)
  }

  // Socket gone: forget the subscriber but keep the PTY running so a reconnect
  // with the same id re-attaches instead of spawning a fresh shell.
  detach(send: (m: ServerMsg) => void): void {
    for (const session of this.map.values()) {
      if (session.send === send) session.send = undefined
    }
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
