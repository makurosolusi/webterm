import { isStaleWorking } from '../shared/agentStale'
import type { AgentStatus } from '../shared/workspace'

/** Status agent beserta jam penulisannya. Jam itulah yang membedakan `working` yang masih hidup
 *  dari `working` yang ditinggal mati (lihat `agentStale.ts`). */
export interface NodeStatusEntry {
  status: AgentStatus
  updatedAt: number
}

/** Kenapa node berhenti: prosesnya keluar SENDIRI, atau kita yang menutupnya. */
export type NodeExitReason = 'self' | 'closed'

/** Tombstone exit per node. Disimpan supaya client yang menyambung ulang tetap bisa merender
 *  `[process exited]` walaupun PTY-nya sudah lama hilang dari memori. */
export interface NodeExit {
  code: number
  reason: NodeExitReason
  at: number
}

/** Batas tombstone exit. Node yang sudah di-forget tidak boleh tumbuh tanpa batas di proses yang
 *  berumur panjang, jadi yang tertua (urutan insert) dibuang lebih dulu. */
export const EXIT_TOMBSTONE_LIMIT = 256

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

  /** `now` di-inject supaya sweep bisa dites tanpa jam dinding; pemanggil nyata melewatkannya. */
  setStatus(id: string, status: AgentStatus, now: number = Date.now()): void {
    // Jamnya dimundurkan pada SETIAP penulisan, termasuk `working` berulang — itulah yang membuat
    // turn panjang yang sah tidak pernah tersapu: tiap tool call menulis ulang `working`.
    this.statuses.set(id, { status, updatedAt: now })
  }

  getStatus(id: string): NodeStatusEntry | undefined {
    const entry = this.statuses.get(id)
    // Salinan: pemanggil tidak boleh bisa memundurkan/memajukan jam lewat referensi.
    return entry ? { ...entry } : undefined
  }

  deleteStatus(id: string): void {
    this.statuses.delete(id)
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
    return swept
  }

  setTranscript(id: string, path: string): void { this.transcripts.set(id, path) }
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
    while (this.exits.size > EXIT_TOMBSTONE_LIMIT) {
      const oldest = this.exits.keys().next().value
      if (oldest === undefined) break
      this.exits.delete(oldest)
    }
  }

  getExit(id: string): NodeExit | undefined {
    const entry = this.exits.get(id)
    return entry ? { ...entry } : undefined
  }

  clearExit(id: string): void { this.exits.delete(id) }

  /** Lupakan semua fakta tentang satu node. Dipakai `close`/restart supaya id yang dipakai ulang
   *  tidak mewarisi status, transcript, maupun tombstone milik sesi mati. */
  forget(id: string): void {
    this.statuses.delete(id)
    this.transcripts.delete(id)
    this.exits.delete(id)
  }
}
