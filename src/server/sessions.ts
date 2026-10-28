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
import { binaryExists, spawnPty, unwrapMissingWrapper, type Pty } from './pty'
import { buildClaudeFlags, forgetNodeToken, hookEnv } from './hooks'

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
  opts?: { permissionMode?: AgentPermissionMode }
): string | undefined {
  const cmd = msg.cmd
  if (!cmd) return undefined
  const agentId = msg.agentId
  const sid = msg.sessionId?.trim()
  // Session id mendarat di baris perintah shell dan datang lewat WebSocket, jadi divalidasi ulang
  // di sini — batas input, bukan sekadar janji tipe.
  if (!agentId || !sid || !isSafeSessionId(sid, true)) return cmd

  // `buildClaudeFlags` memancarkan flag id claude, `--permission-mode` dan `--settings` sebagai satu
  // unit, dan ketiganya grammar claude — jadi gerbangnya daftar kapabilitas, bukan nama agent.
  // `--settings` membawa PATH file settings yang baru ditulis, bukan blob JSON inline (alasannya di
  // `writeClaudeSettings`, hooks.ts) — jadi peluncuran ini menyentuh disk, bukan sekadar merakit string.
  if (hasClaudeHookSettings(agentId)) {
    return `${cmd} ${buildClaudeFlags(msg.id, sid, port, !!msg.resume, {
      permissionMode: opts?.permissionMode,
    })}`
  }
  if (msg.resume) {
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
  private status = new Map<string, AgentStatus>()
  // Hook-fed claude transcript path per node, for context-link reads.
  private transcripts = new Map<string, string>()

  setStatus(id: string, status: AgentStatus): void {
    this.status.set(id, status)
    this.map.get(id)?.send?.({ t: 'status', id, status })
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
      const st = this.status.get(msg.id)
      if (st) send({ t: 'status', id: msg.id, status: st })
      return
    }

    let cmd = launchLine(msg, PORT, { permissionMode: this.options.claudePermissionMode })
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
      session.send?.({ t: 'exit', id: session.id, code })
      this.setStatus(session.id, 'done')
      this.map.delete(session.id)
    })

    if (msg.agentId) this.setStatus(msg.id, 'working')
  }

  input(id: string, data: string): void {
    this.map.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.map.get(id)?.pty.resize(cols, rows)
  }

  close(id: string): void {
    // Token hook terikat pada NODE, bukan pada PTY — jadi dilupakan SEBELUM gerbang sesi hidup di
    // bawah. Sebuah agent yang prosesnya keluar sendiri sudah dihapus dari `map` oleh `onExit`,
    // sehingga `close` yang menyusul akan return lebih awal dan token itu tetap sah selamanya
    // padahal node id-nya bisa dipakai ulang sesi berikutnya.
    forgetNodeToken(id)
    const session = this.map.get(id)
    if (!session) return
    session.pty.kill()
    this.map.delete(id)
    this.status.delete(id)
    this.transcripts.delete(id)
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
      case 'close': this.close(msg.id); break
    }
  }
}

export const sessions = new Sessions()
