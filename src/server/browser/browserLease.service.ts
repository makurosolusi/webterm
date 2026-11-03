// Lease node browser (PLAN b §4.7): siapa yang mengemudi, human atau agent. Murni in-memory, jam diinjeksi.
// Kedaluwarsa dihitung malas (saat dibaca) + `sweep()` untuk integrator yang ingin menyiarkan perubahannya.
import { HUMAN_IDLE_MS, LEASE_TTL_MS } from '../../shared/browser.contract'
import type { Lease, LeaseView } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.lease')

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

  /** Catat input manusia (dasar penolakan `handoff` dalam `HUMAN_IDLE_MS`). */
  noteHumanInput(nodeId: string): void {
    this.rec(nodeId).humanAt = this.now()
  }

  /** Aksi `takeover` dari UI: lease kembali ke human. */
  takeover(nodeId: string): void {
    this.release(nodeId)
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

  /** Verb aksi wajib lease agent: `lease_human` bila tidak; sekaligus memperpanjang TTL. */
  requireAgent(nodeId: string): void {
    if (this.holder(nodeId) !== 'agent') throw new BrowserError('lease_human', `node ${nodeId}: agent does not hold the lease`)
    this.touch(nodeId)
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
