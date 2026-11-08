// Lease node browser (PLAN b §4.7): siapa yang mengemudi, human atau agent. Murni in-memory, jam diinjeksi.
// Kedaluwarsa dihitung malas (saat dibaca) + `sweep()` untuk integrator yang ingin menyiarkan perubahannya.
import { HUMAN_IDLE_MS, LEASE_TTL_MS } from '../../shared/browser.contract'
import type { Lease, LeaseView } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.lease')

/** Longest an agent action waits for the user to stop typing/clicking before answering `human_active`. */
export const HUMAN_WAIT_MAX_MS = 2 * HUMAN_IDLE_MS

interface Rec { agentAt?: number; humanAt?: number }

export class LeaseService implements LeaseView {
  private readonly nodes = new Map<string, Rec>()
  private readonly listeners = new Set<(nodeId: string, lease: Lease) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Pemegang lease saat ini; lease agent tanpa aktivitas `LEASE_TTL_MS` kembali ke human. */
  holder(nodeId: string): Lease {
    const rec = this.nodes.get(nodeId)
    if (rec?.agentAt === undefined) return 'human'
    if (this.now() - rec.agentAt < LEASE_TTL_MS) return 'agent'
    rec.agentAt = undefined
    this.emit(nodeId, 'human')
    return 'human'
  }

  /** Catat input manusia (agent menunggu sampai `HUMAN_IDLE_MS` berlalu sejak input terakhir). */
  noteHumanInput(nodeId: string): void {
    this.rec(nodeId).humanAt = this.now()
  }

  /** Aksi `takeover` dari UI: lease kembali ke human; dihitung input agar aksi agent berikutnya tidak langsung merebutnya lagi. */
  takeover(nodeId: string): void {
    this.noteHumanInput(nodeId)
    this.release(nodeId)
  }

  /**
   * Ambil lease untuk aksi agent: tanpa langkah handoff. Input manusia baru-baru ini ditunggu di server sampai
   * idle; bila terus berlanjut melewati `HUMAN_WAIT_MAX_MS`, melempar `human_active`. Mati = `disabled`.
   */
  async acquire(nodeId: string, allowed: boolean, sleep: (ms: number) => Promise<void>): Promise<{ lease: 'agent'; ttlMs: number }> {
    if (allowed && this.holder(nodeId) === 'human') {
      const deadline = this.now() + HUMAN_WAIT_MAX_MS
      for (let left = this.humanIdleIn(nodeId); left > 0; left = this.humanIdleIn(nodeId)) {
        if (this.now() + left > deadline) throw new BrowserError('human_active', `node ${nodeId}: the user is using this browser right now`)
        await sleep(left)
      }
    }
    return this.handoff(nodeId, allowed) // tanpa await sejak cek terakhir: tidak ada celah input manusia
  }

  /** human -> agent. `allowed` = agentControl node + env agent; melempar `disabled` / `human_active`. */
  handoff(nodeId: string, allowed: boolean): { lease: 'agent'; ttlMs: number } {
    if (!allowed) throw new BrowserError('disabled', `handoff refused for node ${nodeId}: agent control is off`)
    const rec = this.rec(nodeId)
    const wasHuman = this.holder(nodeId) === 'human'
    if (wasHuman && rec.humanAt !== undefined && this.now() - rec.humanAt < HUMAN_IDLE_MS) {
      throw new BrowserError('human_active', `handoff refused for node ${nodeId}: human input within ${HUMAN_IDLE_MS} ms`)
    }
    rec.agentAt = this.now()
    if (wasHuman) this.emit(nodeId, 'agent')
    return { lease: 'agent', ttlMs: LEASE_TTL_MS }
  }

  /** agent -> human (idempotens). */
  release(nodeId: string): void {
    const rec = this.nodes.get(nodeId)
    if (rec?.agentAt === undefined) return
    rec.agentAt = undefined
    this.emit(nodeId, 'human')
  }

  /** Perpanjang TTL bila agent memegang lease (dipanggil tiap verb agent). */
  touch(nodeId: string): void {
    if (this.holder(nodeId) === 'agent') this.rec(nodeId).agentAt = this.now()
  }

  /** Lease agent aktif = node `driven` (tidak boleh di-discard oleh lifecycle). */
  isDriven(nodeId: string): boolean {
    return this.holder(nodeId) === 'agent'
  }

  /** Dengarkan perubahan lease (untuk menyiarkan ke UI); mengembalikan fungsi berhenti. */
  onChange(cb: (nodeId: string, lease: Lease) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Paksa evaluasi kedaluwarsa semua node (panggil berkala); mengembalikan node yang baru kembali ke human. */
  sweep(): string[] {
    const expired: string[] = []
    for (const [id, rec] of this.nodes) {
      if (rec.agentAt !== undefined && this.holder(id) === 'human') expired.push(id)
    }
    return expired
  }

  /** Sisa ms sampai manusia dianggap idle (<= 0 = sudah idle). */
  private humanIdleIn(nodeId: string): number {
    const at = this.nodes.get(nodeId)?.humanAt
    return at === undefined ? 0 : at + HUMAN_IDLE_MS - this.now()
  }

  private rec(nodeId: string): Rec {
    let rec = this.nodes.get(nodeId)
    if (!rec) this.nodes.set(nodeId, (rec = {}))
    return rec
  }

  private emit(nodeId: string, lease: Lease): void {
    for (const cb of this.listeners) {
      try {
        cb(nodeId, lease)
      } catch (err) {
        log.error('browser.lease', 'lease listener threw', { ids: { nodeId }, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}
