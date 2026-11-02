import type { ServerMsg } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { STALE_SWEEP_MS } from '../shared/agentStale'
import { NodeRegistry, tailOutputBytes, type NodeExit } from './nodeRegistry'
import { OutputLog } from './outputLog'
import type { Session, SessionInfo, SessionsOptions } from './sessionsTypes'

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
  constructor(public options: SessionsOptions = {}) {}

  /** Batas scrollback efektif. Nilai settings bisa diedit tangan / datang lewat HTTP, jadi
   *  divalidasi di titik pemakaian; nilai tak masuk akal jatuh ke default. */
  protected get scrollbackBytes(): number {
    const n = this.options.scrollbackBytes
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.scrollbackBytes
  }

  protected now(): number {
    return (this.options.now ?? Date.now)()
  }

  protected map = new Map<string, Session>()
  // Status, transcript, dan tombstone exit hidup LEBIH LAMA dari PTY-nya — makanya di registry,
  // bukan di `Session`. Node yang sudah mati tetap perlu bisa dijawab (lihat nodeRegistry.ts).
  protected registry = new NodeRegistry()

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
  /**
   * Teks terminal: log HIDUP bila sesinya masih ada, kalau tidak ekor output yang tersimpan di
   * tombstone exit. Tanpa fallback ini, `wait until:exit` selalu menjawab `output: ''` — sesi
   * dihapus tepat saat keluar, jadi pemanggil kehilangan seluruh alasan ia menunggu. Tombstone
   * dibaca, bukan dihidupkan lagi: tidak ada PTY atau `Session` yang dibuat ulang di sini.
   */
  getTerminal(id: string): string {
    const live = this.map.get(id)
    if (live) return live.log.text()
    return this.registry.getExit(id)?.output ?? ''
  }
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

  /** Socket gone: forget every subscriber but keep the PTY running so a reconnect with the same id
   *  re-attaches instead of spawning a fresh shell. */
  detach(send: (m: ServerMsg) => void): void {
    for (const session of this.map.values()) session.subs.remove(send)
  }

  /** Tambah `data` ke log (dengan cap byte) lalu pancarkan ke semua pelanggan, bernomor urut. */
  protected emit(session: Session, data: string): void {
    // PTY sesekali memanggil onData dengan string kosong. OutputLog tidak memberinya seq (ia
    // mengembalikan seq terakhir), jadi memancarkannya berarti pelanggan menerima `output` dengan
    // nomor urut duplikat — no-op, tapi membingungkan deteksi gap di client.
    if (data === '') return
    const seq = session.log.append(data, this.scrollbackBytes)
    session.subs.send({ t: 'output', id: session.id, data, seq })
  }

  /** PTY keluar SENDIRI. Gerbang identitas: gema dari `close` tidak boleh menulis status/exit. */
  protected onExit(session: Session, code: number): void {
    if (this.map.get(session.id) !== session || session.exited) return
    session.exited = true
    const at = this.now()
    // `done` DULU, tombstone exit sesudahnya: `setStatus` mengabaikan node yang sudah punya
    // tombstone (lihat guard di sana), jadi urutan sebaliknya membuat `done` hilang.
    this.setStatus(session.id, 'done', at)
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
