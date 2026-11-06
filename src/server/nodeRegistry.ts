import { isStaleWorking } from '../shared/agentStale'
import type { AgentStatus } from '../shared/workspace'

/** Status agent beserta jam penulisannya. Jam itulah yang membedakan `working` yang masih hidup
 *  dari `working` yang ditinggal mati (lihat `agentStale.ts`). */
export interface NodeStatusEntry {
  status: AgentStatus
  updatedAt: number
}

/** Kenapa node berhenti: prosesnya keluar SENDIRI, atau kita yang menutupnya. `failed` = the open
 *  itself threw before any process ran (agent-211-A1); like `closed` it only fills an empty slot. */
export type NodeExitReason = 'self' | 'closed' | 'failed'

/** Tombstone exit per node. Disimpan supaya client yang menyambung ulang tetap bisa merender
 *  `[process exited]` walaupun PTY-nya sudah lama hilang dari memori. */
export interface NodeExit {
  code: number
  reason: NodeExitReason
  at: number
  /** Ekor output terakhir sesi (maks `EXIT_OUTPUT_LIMIT` byte). Disimpan di tombstone karena
   *  `OutputLog` ikut hilang bersama PTY-nya, sedangkan pemanggil `wait until:exit` justru butuh
   *  output itu sebagai alasan ia menunggu. */
  output?: string
}

/** Batas tombstone exit. Node yang sudah di-forget tidak boleh tumbuh tanpa batas di proses yang
 *  berumur panjang, jadi yang tertua (urutan insert) dibuang lebih dulu. */
export const EXIT_TOMBSTONE_LIMIT = 256

/** Batas byte output yang ikut tombstone. Total memori tetap terbatas oleh
 *  `EXIT_TOMBSTONE_LIMIT * EXIT_OUTPUT_LIMIT` (256 * 64 KiB = 16 MiB) walau proses berumur panjang. */
export const EXIT_OUTPUT_LIMIT = 64 * 1024

const encoder = new TextEncoder()

/**
 * Ambil `limit` byte TERAKHIR dari `text` tanpa memotong di tengah karakter UTF-8.
 *
 * Kenapa dihitung per code point dari belakang, bukan `encode().slice()`: potongan byte mentah bisa
 * membelah karakter multi-byte dan menghasilkan karakter pengganti di awal output. Batas dihitung
 * dalam byte karena itulah batas memori sesungguhnya (emoji/CJK 3-4 byte per karakter).
 */
export function tailOutputBytes(text: string, limit: number = EXIT_OUTPUT_LIMIT): string {
  if (limit <= 0) return ''
  if (encoder.encode(text).length <= limit) return text
  let bytes = 0
  let i = text.length
  while (i > 0) {
    const lo = text.charCodeAt(i - 1)
    // Pasangan surrogate: mundur dua code unit supaya emoji tidak terbelah.
    const pair = lo >= 0xdc00 && lo <= 0xdfff && i >= 2 &&
      text.charCodeAt(i - 2) >= 0xd800 && text.charCodeAt(i - 2) <= 0xdbff
    const cp = pair ? text.codePointAt(i - 2)! : lo
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + size > limit) break
    bytes += size
    i -= pair ? 2 : 1
  }
  return text.slice(i)
}

/** Batas jumlah status DAN transcript yang disimpan. Sama alasannya dengan tombstone exit: proses
 *  ini berumur panjang, dan status/transcript hanya dibersihkan oleh `open`/`close` id yang PERSIS
 *  sama — sedangkan id baru bisa datang dari mana saja (hook HTTP). Yang tertua (urutan insert)
 *  dibuang lebih dulu. */
export const MAX_NODE_STATE = 1024

/** Buang entri tertua (urutan insert) sampai `map` muat. Penulisan ulang key yang SUDAH ada tidak
 *  mengubah urutan insert, jadi node yang rajin menulis status pun bisa tergusur oleh 1024 id baru
 *  — konsekuensi yang sama dengan tombstone exit, dan lebih baik daripada tumbuh tanpa batas. */
function evictInsertionOrder<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * Ingatan per-node yang hidup LEBIH LAMA dari PTY-nya: status, path transcript, dan tombstone exit.
 *
 * Sengaja murni in-memory dan tanpa impor `sessions` — `Sessions` yang memegang PTY, registry ini
 * yang memegang fakta tentang node. Pemisahan itu membuat sweep bisa dites tanpa menunggu 20 menit
 * maupun men-spawn shell.
 */
export class NodeRegistry {
  private statuses = new Map<string, NodeStatusEntry>()
  private transcripts = new Map<string, string>()
  private exits = new Map<string, NodeExit>()
  /** Called after every status write, delete or sweep: the one hook the durable store needs (A4). */
  onStatusChange?: () => void

  /** `now` di-inject supaya sweep bisa dites tanpa jam dinding; pemanggil nyata melewatkannya. */
  setStatus(id: string, status: AgentStatus, now: number = Date.now()): void {
    // Jamnya dimundurkan pada SETIAP penulisan, termasuk `working` berulang — itulah yang membuat
    // turn panjang yang sah tidak pernah tersapu: tiap tool call menulis ulang `working`.
    const changed = this.statuses.get(id)?.status !== status
    this.statuses.set(id, { status, updatedAt: now })
    evictInsertionOrder(this.statuses, MAX_NODE_STATE)
    if (changed) this.onStatusChange?.()
  }

  /** Every stored status (a copy), for the durable snapshot. */
  statusEntries(): [string, NodeStatusEntry][] {
    return [...this.statuses].map(([id, e]) => [id, { ...e }])
  }

  getStatus(id: string): NodeStatusEntry | undefined {
    const entry = this.statuses.get(id)
    // Salinan: pemanggil tidak boleh bisa memundurkan/memajukan jam lewat referensi.
    return entry ? { ...entry } : undefined
  }

  deleteStatus(id: string): void {
    if (this.statuses.delete(id)) this.onStatusChange?.()
  }

  /**
   * Hapus status `working` yang sudah diam melewati jendela, dan kembalikan id yang tersapu.
   *
   * MENGHAPUS, bukan menggantinya dengan `done`/`waiting` — alasannya di `agentStale.ts`. Node yang
   * tersapu dirender "Unknown", dan event berikutnya menaruhnya kembali ke `working` (self-healing).
   */
  sweepStale(now: number = Date.now()): string[] {
    const swept: string[] = []
    for (const [id, entry] of this.statuses) {
      if (!isStaleWorking(entry.status, entry.updatedAt, now)) continue
      this.statuses.delete(id)
      swept.push(id)
    }
    if (swept.length) this.onStatusChange?.()
    return swept
  }

  setTranscript(id: string, path: string): void {
    this.transcripts.set(id, path)
    evictInsertionOrder(this.transcripts, MAX_NODE_STATE)
  }
  getTranscript(id: string): string | undefined { return this.transcripts.get(id) }
  deleteTranscript(id: string): void { this.transcripts.delete(id) }

  /**
   * Catat tombstone exit. `self` menang atas `closed`: proses yang keluar sendiri adalah bukti
   * langsung, sedangkan `closed` hanya "kita yang membunuhnya" dan bisa menyusul sebagai gema.
   * Karena itu `closed` hanya mengisi slot yang masih kosong.
   */
  setExit(id: string, exit: NodeExit): void {
    const existing = this.exits.get(id)
    if (existing) {
      if (!(existing.reason === 'closed' && exit.reason === 'self')) return
      // Update di tempat: urutan insert tidak berubah, jadi umur tombstone tidak diperpanjang.
      this.exits.set(id, { ...exit })
      return
    }
    this.exits.set(id, { ...exit })
    evictInsertionOrder(this.exits, EXIT_TOMBSTONE_LIMIT)
  }

  getExit(id: string): NodeExit | undefined {
    const entry = this.exits.get(id)
    return entry ? { ...entry } : undefined
  }

  clearExit(id: string): void { this.exits.delete(id) }

  /** Lupakan semua fakta tentang satu node. Dipakai `close`/restart supaya id yang dipakai ulang
   *  tidak mewarisi status, transcript, maupun tombstone milik sesi mati. */
  forget(id: string): void {
    this.deleteStatus(id)
    this.transcripts.delete(id)
    this.exits.delete(id)
  }
}
