import type { ClientMsg, OpenMsg, ServerMsg } from '../shared/protocol'
import { hasClaudeHookSettings, isContextCapable, isSafeNodeId } from '../shared/workspace'
import { binaryExists, spawnPty, unwrapMissingWrapper } from './pty'
import { forgetNodeToken, hookEnv, nodeToken } from './hooks'
import { resumeIsDead, transcriptMissingNotice } from './transcriptPresence'
import { OutputLog } from './outputLog'
import { SubscriberSet } from './subscribers'
import { PORT, launchLine, wrapperMissingNotice } from './launchLine'
import { SessionsCore, exitOutput } from './sessionsCore'
import type { Session, SessionInfo, SessionsOptions } from './sessionsTypes'

// `launchLine` dulu tinggal di file ini dan diimpor dari sini oleh test/pemanggil lama. Re-export
// menjaga kontrak itu tanpa memaksa semua pemanggil tahu file barunya.
export { launchLine }

// Keadaan sesi (map, registry, jam sweep, emit/onExit) tinggal di `sessionsCore.ts`; tipe-tipenya di
// `sessionsTypes.ts`. Keduanya dipecah hanya karena ukuran file — kontrak publik tetap di sini.
export type { SessionInfo, SessionsOptions }

/**
 * Jalur socket di atas `SessionsCore`: buka/re-attach, input, resize, close, dan dispatch pesan
 * client. Setiap perilaku (replay scrollback, tombstone exit, gerbang identitas `onExit`) sama
 * persis dengan versi satu-file; yang berubah hanya letak kodenya.
 */
export class Sessions extends SessionsCore {
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
    // Tiga set env var yang digerbangi TERPISAH:
    //  - `WEBTERM_TOKEN` = token NODE (bukan token root server), untuk SEMUA sesi agent. Hook yang
    //    kita tanam membaca `$WEBTERM_TOKEN` dari env anak, jadi tanpa ini hook agent tak bisa
    //    mengautentikasi begitu token root tidak lagi diwarisi (`ptyShell.ts` membuang `WEBTERM_*`).
    //  - `NODETERM_NODE_ID`/`NODETERM_PORT` dibaca skill konteks-tertaut di dalam sesi agent.
    //  - `hookEnv` membawa token node untuk jalur curl `--settings` + batas tahan hook permission.
    // Terminal biasa (tanpa `agentId`) tidak mendapat satu pun: ia tidak butuh kunci apa pun.
    const env: Record<string, string> = {
      ...(msg.agentId ? { WEBTERM_TOKEN: nodeToken(msg.id) } : {}),
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
    // Output diambil SEBELUM `map.delete`: `OutputLog` hidup di dalam `Session`, dan tombstoneyalah
    // satu-satunya tempat ia bertahan sesudah sesi dibuang.
    if (firstClose) {
      this.registry.setExit(id, {
        code: -1,
        reason: 'closed',
        at: this.now(),
        output: exitOutput(session?.log),
      })
    }
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
