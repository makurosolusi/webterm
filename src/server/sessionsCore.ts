import type { ServerMsg, StatusMsg, StatusReason } from '../shared/protocol'
import type { Pty } from './pty'
import { SubscriberSet } from './subscribers'
import { DA_REPLY_TTL_OTHER_MS, DA_REPLY_TTL_TMUX_MS, DaReplyGate } from './daReplyGate'
import { producePtyExit } from './events/producers'
import type { StatusStore } from './sessionsStatusStore'
import type { AgentStatus } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { clampSetting } from '../shared/settings.ranges'
import { STALE_SWEEP_MS } from '../shared/agentStale'
import { NodeRegistry, tailOutputBytes, type NodeExit, type NodeStatusEntry, type StaleSweepEntry } from './nodeRegistry'
import { OutputLog } from './outputLog'
import type { Session, SessionInfo, SessionsOptions } from './sessionsTypes'
import { ptyLog } from './sessionsLog'
import type { TmuxSupervisor } from './ptySupervisor'
import { nextEpoch, replay } from './sessionsAttach'
import { createLogger } from './logs'

const agentLog = createLogger('agent')

/** Ekor output yang ikut tombstone exit. Kosong = `undefined`, supaya tombstone node tanpa output
 *  tidak membawa string kosong dan `getExit()` tetap ringkas dibandingkan. */
export function exitOutput(log: OutputLog | undefined): string | undefined {
  const text = log?.text() ?? ''
  return text === '' ? undefined : tailOutputBytes(text)
}

/**
 * Keadaan sesi BERSAMA semua jalur: map PTY hidup, registry status/transcript/tombstone, jam
 * sweep, dan pengiriman ke pelanggan. `Sessions` (lihat `sessions.ts`) menambahkan jalur socket
 * (open/input/resize/close/handle) di atasnya; pemisahan ini hanya soal ukuran file, bukan
 * perubahan perilaku — setiap field dan urutan operasinya sama dengan versi satu-file.
 */
export class SessionsCore {
  /** `supervisor` hidup TERPISAH dari `options`: `applyPtyOptions` (api.ts) menimpa seluruh objek
   *  `options` pada setiap PUT settings, dan supervisor tidak boleh ikut hilang karenanya. */
  constructor(public options: SessionsOptions = {}, public supervisor: TmuxSupervisor | null = null) {
    this.registry.onStatusChange = () => this.statusStore?.save(this.registry.statusEntries())
  }

  /** Durable last status per node (A4). Set by the singleton only, like `supervisor` it lives outside
   *  `options`, so `new Sessions()` in a test writes nothing unless it hands in a tmp-path store. */
  statusStore?: StatusStore

  /** Told about each node the stale sweep removes. Set by the singleton only, like `statusStore`. */
  onStaleSweep?: (entry: StaleSweepEntry) => void

  /** Supervisor yang benar-benar dipakai. PTY ter-inject (test) tidak pernah lewat tmux. */
  protected get supervised(): TmuxSupervisor | null {
    return this.options.spawn ? null : this.supervisor
  }

  /** Batas scrollback efektif. Nilai settings bisa diedit tangan / datang lewat HTTP, jadi
   *  divalidasi di titik pemakaian: tak sah -> default, di luar rentang tabel -> dijepit (bukan
   *  hanya `n > 0`, supaya 1 byte atau 1e12 tidak lolos ke ring buffer). */
  protected get scrollbackBytes(): number {
    return clampSetting('scrollbackBytes', this.options.scrollbackBytes, DEFAULT_SETTINGS.scrollbackBytes)
  }

  protected now(): number {
    return (this.options.now ?? Date.now)()
  }

  protected map = new Map<string, Session>()
  // Status, transcript, dan tombstone exit hidup LEBIH LAMA dari PTY-nya — makanya di registry,
  // bukan di `Session`. Node yang sudah mati tetap perlu bisa dijawab (lihat nodeRegistry.ts).
  protected registry = new NodeRegistry()

  /** Sends a status frame to every open UI socket. Set by the singleton only (sessions.ts), so a
   *  `new Sessions()` in a test stays db-free; unset = PTY subscribers only, as before. */
  broadcast?: (m: ServerMsg) => void

  /** Status frames go to EVERY UI socket when wired: the Sessions panel lists nodes of every board,
   *  and a client that never opened this PTY still needs its status. Subscribers sit on those same
   *  sockets, so they are not sent to twice. */
  protected sendStatus(id: string, m: StatusMsg): void {
    if (this.broadcast) this.broadcast(m)
    else this.map.get(id)?.subs.send(m)
  }

  /** The status frame of `id` as stored now (status absent = nothing known). */
  statusMsgOf(id: string): StatusMsg {
    const status = this.registry.getStatus(id)?.status
    return { t: 'status', id, ...(status ? { status, ...this.registry.reasonOf(id) } : {}) }
  }

  /** Every stored status as frames, for a socket that just connected (terminalSocket.ts). Bounded by MAX_NODE_STATE. */
  statusSnapshot(): StatusMsg[] {
    return this.registry.statusEntries().map(([id]) => ({ ...this.statusMsgOf(id), snapshot: true as const }))
  }

  /** Tulis status lalu pancarkan (lihat `sendStatus`). `reason` = why it needs you or failed, when known.
   *  Sesi tanpa pelanggan tetap menyimpan statusnya: re-attach memutar ulang status itu sebagai snapshot. */
  setStatus(id: string, status: AgentStatus, now: number = this.now(), reason?: StatusReason): void {
    // Node yang sudah punya tombstone exit adalah node MATI. Hook yang telat (mis. `Stop` claude
    // mendarat sesudah shell-nya keluar) tidak boleh menghidupkan lagi statusnya — client akan
    // merender node mati itu sebagai aktif dan menawarkan Resume.
    if (this.registry.getExit(id)) return
    const prev = this.registry.getStatus(id)?.status
    if (prev !== status) ptyLog.status(id, prev, status)
    this.registry.setStatus(id, status, now, reason)
    this.sendStatus(id, this.statusMsgOf(id))
  }

  /**
   * Hapus status `working` yang sudah diam melewati jendela. MENGHAPUS, bukan menggantinya dengan
   * `done`/`waiting` — alasannya di `agentStale.ts`. Self-healing: event berikutnya menulis ulang.
   */
  sweepStale(now: number = this.now()): void {
    for (const entry of this.registry.sweepStale(now)) {
      const { id } = entry
      ptyLog.statusCleared(id)
      // `status` absen = "tidak ada status lagi". The client falls back to liveness (a live node reads Idle).
      this.sendStatus(id, { t: 'status', id })
      try {
        this.onStaleSweep?.(entry)
      } catch (err) {
        agentLog.warn('agent.stale.report_failed', 'Failed to report stale sweep of node', { ids: { nodeId: id }, cause: err instanceof Error ? err.message : String(err) })
      }
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
  /**
   * Teks terminal: log HIDUP bila sesinya masih ada, kalau tidak ekor output yang tersimpan di
   * tombstone exit. Tanpa fallback ini, `wait until:exit` selalu menjawab `output: ''` — sesi
   * dihapus tepat saat keluar, jadi pemanggil kehilangan seluruh alasan ia menunggu. Tombstone
   * dibaca, bukan dihidupkan lagi: tidak ada PTY atau `Session` yang dibuat ulang di sini.
   */
  getTerminal(id: string): string {
    const live = this.map.get(id)
    // Sesi tmux: log-nya berisi gambar ulang layar (posisi kursor), bukan teks berurutan, jadi
    // teksnya dibaca dari pane — termasuk history dari sebelum server restart.
    if (live) return this.supervised?.capture(id) ?? live.log.text()
    return this.registry.getExit(id)?.output ?? ''
  }
  /** Raw output log + current size of a LIVE session, so its visible screen can be rebuilt
   *  server-side (`linkNoteScreen.ts`). `seq` changes whenever new output arrives. */
  screenSource(id: string): { data: string; seq: number; cols: number; rows: number; pid: number } | undefined {
    const s = this.map.get(id)
    return s && { data: s.log.text(), seq: s.log.lastSeq(), cols: s.cols, rows: s.rows, pid: s.pty.pid }
  }
  statusOf(id: string): AgentStatus | undefined { return this.registry.getStatus(id)?.status }
  isLive(id: string): boolean { return this.map.has(id) }
  getExit(id: string): NodeExit | undefined { return this.registry.getExit(id) }
  pidOf(id: string): number | undefined { return this.map.get(id)?.pty.pid }
  /** PTY facts of a LIVE session (node status bar); undefined once it is gone. */
  ptyInfoOf(id: string): { pid: number; startedAt: number; cols: number; rows: number } | undefined {
    const s = this.map.get(id)
    return s && { pid: s.pty.pid, startedAt: s.startedAt, cols: s.cols, rows: s.rows }
  }
  /** Status with its clocks: last write (`updatedAt`) and start of this status (`since`). */
  statusEntryOf(id: string): (NodeStatusEntry & { since?: number; reason?: StatusReason }) | undefined {
    const e = this.registry.getStatus(id)
    const reason = this.registry.reasonOf(id)
    return e && { ...e, since: this.registry.statusSince(id), ...(reason ? { reason } : {}) }
  }
  /** The agent a LIVE session was launched as (undefined = plain shell or no session). */
  agentIdOf(id: string): string | undefined { return this.map.get(id)?.agentId }

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

  /** Socket gone: forget every subscriber but keep the PTY running so a reconnect with the same id
   *  re-attaches instead of spawning a fresh shell. */
  detach(send: (m: ServerMsg) => void): void {
    for (const session of this.map.values()) session.subs.remove(send)
  }

  /** A socket that dropped output for `id` (backpressure, terminalSocket.ts) gets reset + full
   *  replay, but only while it is still subscribed: a closed or detached view wants nothing. */
  resync(id: string, send: (m: ServerMsg) => void): void {
    const session = this.map.get(id)
    if (session?.subs.has(send)) replay(session, send)
  }

  /** Tambah `data` ke log (dengan cap byte) lalu pancarkan ke semua pelanggan, bernomor urut. */
  protected emit(session: Session, data: string): void {
    // PTY sesekali memanggil onData dengan string kosong. OutputLog tidak memberinya seq (ia
    // mengembalikan seq terakhir), jadi memancarkannya berarti pelanggan menerima `output` dengan
    // nomor urut duplikat — no-op, tapi membingungkan deteksi gap di client.
    if (data === '') return
    session.daReplies.noteOutput(data, this.now())
    const seq = session.log.append(data, this.scrollbackBytes)
    session.subs.send({ t: 'output', id: session.id, data, seq })
  }

  /** Daftarkan PTY hidup sebagai sesi node dan sambungkan output/exit-nya. */
  protected track(id: string, pty: Pty, agentId: string | undefined, cols: number, rows: number): Session {
    const session: Session = {
      id, pty, agentId, cols, rows, epoch: nextEpoch(),
      daReplies: new DaReplyGate(this.supervised ? DA_REPLY_TTL_TMUX_MS : DA_REPLY_TTL_OTHER_MS),
      log: new OutputLog(),
      subs: new SubscriberSet<ServerMsg>(),
      exited: false,
      startedAt: this.now(),
    }
    this.map.set(id, session)
    pty.onData((data) => this.emit(session, data))
    pty.onExit((code) => {
      // Same identity gate as `onExit`: only the first exit of the live session becomes an event.
      const live = this.map.get(id) === session && !session.exited
      this.onExit(session, code)
      if (live) producePtyExit({ nodeId: id, agentId, code, reason: 'self', durationMs: this.now() - session.startedAt })
    })
    return session
  }

  /** PTY keluar SENDIRI. Gerbang identitas: gema dari `close` tidak boleh menulis status/exit. */
  protected onExit(session: Session, code: number): void {
    if (this.map.get(session.id) !== session || session.exited) return
    session.exited = true
    const at = this.now()
    ptyLog.exited(session.id, session.agentId, code, 'self', at - session.startedAt)
    // An agent that exits non-zero failed: it is never shown as Done with Resume offered (A2). Under
    // tmux the attach client always exits 0, so there `open` probes the program before spawning.
    const failed = !!session.agentId && code !== 0
    // Status DULU, tombstone exit sesudahnya: `setStatus` mengabaikan node yang sudah punya
    // tombstone (lihat guard di sana), jadi urutan sebaliknya membuat statusnya hilang.
    this.setStatus(session.id, failed ? 'failed' : 'done', at)
    this.registry.setExit(session.id, {
      code,
      reason: 'self',
      at,
      output: exitOutput(session.log),
    })
    session.subs.send({ t: 'exit', id: session.id, code, reason: 'self' })
    session.subs.clear()
    this.map.delete(session.id)
  }
}
