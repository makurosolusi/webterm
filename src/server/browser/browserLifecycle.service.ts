// BrowserLifecycle: hibernate 3 tingkat (live -> paused -> discarded), batas MAX_LIVE, timer discard.
// Gateway (WS-04) melaporkan visibilitas lewat `setVisible` dan memanggil `attach`; saat node kembali
// terlihat, gateway sendiri memulai ulang screencast (lifecycle hanya menghentikannya saat paused).
import { DEFAULT_DISCARD_MS, DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../../shared/browser.contract'
import type { BlockReason, BrowserHostApi, BrowserState, LiveState } from '../../shared/browser.contract'
import { shouldDiscard } from '../../shared/browser.discard'
import { createLogger } from '../logs'
import { LiveQueue } from './browserLifecycle.queue'

const log = createLogger('browser.lifecycle')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Jeda coba ulang discard bila node masih memuat atau dikemudikan agent saat timer menyala. */
export const DISCARD_RETRY_MS = 60_000

export interface LifecycleConfig { maxLive: number; discardMs: number }

/** Baca MAX_LIVE (di-clamp ke MAX_LIVE_RANGE) dan DISCARD_MS dari env; nilai rusak = default. */
export function lifecycleConfig(env: Record<string, string | undefined>): LifecycleConfig {
  const maxLive = Number.parseInt(env[ENV_BROWSER.maxLive] ?? '', 10)
  const discardMs = Number(env[ENV_BROWSER.discardMs]?.trim() || Number.NaN)
  return {
    maxLive: Number.isFinite(maxLive) ? Math.min(MAX_LIVE_RANGE.max, Math.max(MAX_LIVE_RANGE.min, maxLive)) : DEFAULT_MAX_LIVE,
    discardMs: Number.isFinite(discardMs) && discardMs >= 0 ? discardMs : DEFAULT_DISCARD_MS,
  }
}

export interface LifecycleDeps extends Omit<LifecycleConfig, 'maxLive'> {
  /** Batas node hidup; fungsi = dibaca tiap attach, jadi pengaturan berlaku seketika tanpa restart. */
  maxLive: number | (() => number)
  host: BrowserHostApi
  /** Lease agent aktif (WS-07): node `driven` tidak boleh di-discard. */
  driven: (nodeId: string) => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  retryMs?: number
}

export type AttachResult = { ok: true; state: BrowserState } | { ok: false; blocked: Extract<BlockReason, 'max_live'> }

export class BrowserLifecycle {
  private readonly queue = new LiveQueue()
  private readonly timers = new Map<string, unknown>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly retryMs: number
  private readonly unsub: () => void
  private gate: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms)
      ;(t as { unref?: () => void }).unref?.() // timer discard tidak boleh menahan proses
      return t
    })
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.retryMs = deps.retryMs ?? DISCARD_RETRY_MS
    this.unsub = deps.host.onState((s) => { if (s.live === 'discarded') this.forget(s.id) }) // crash/discard dari luar
  }

  /** Tingkat saat ini: live (terlihat) | paused (tersembunyi) | discarded; undefined bila node tak dikenal. */
  tier(nodeId: string): LiveState | undefined {
    const e = this.queue.get(nodeId)
    if (e) return e.visible ? 'live' : 'paused'
    return this.deps.host.state(nodeId)?.live
  }

  /** Buka node untuk penonton: patuhi MAX_LIVE; node discarded dipulihkan dari url terakhir (atau `url`). */
  async attach(nodeId: string, workspaceId: string, url?: string): Promise<AttachResult> {
    if (this.disposed) throw new Error(`lifecycle disposed: attach ${nodeId}`)
    if (!(await this.admit(nodeId))) return { ok: false, blocked: 'max_live' }
    try {
      const last = this.deps.host.state(nodeId)?.url
      return { ok: true, state: await this.deps.host.open(nodeId, workspaceId, url ?? (last || undefined)) }
    } catch (err) {
      if (this.deps.host.state(nodeId)?.live !== 'live') this.forget(nodeId) // gagal buka: lepas slot
      throw err
    }
  }

  /** Gateway melaporkan node terlihat/tersembunyi. Tersembunyi = paused (stopScreencast) + timer discard. */
  setVisible(nodeId: string, visible: boolean): void {
    if (this.disposed) return
    const e = this.queue.setVisible(nodeId, visible, this.now())
    if (!e) return
    if (visible) { this.cancel(nodeId); return }
    if (this.timers.has(nodeId)) return // sudah tersembunyi, timer jalan
    this.deps.host.stopScreencast(nodeId).catch((err) => log.warn('browser.pause', 'stopScreencast failed', { ids: { nodeId }, error: errMsg(err) }))
    this.arm(nodeId, this.deps.discardMs)
  }

  /** Lepas node dari pelacakan tanpa menyentuh host (node dihapus / target hilang). */
  forget(nodeId: string): void {
    this.cancel(nodeId)
    this.queue.remove(nodeId)
  }

  /** Hentikan semua timer dan langganan; tidak ada timer tersisa. */
  dispose(): void {
    this.disposed = true
    this.unsub()
    for (const id of [...this.timers.keys()]) this.cancel(id)
    for (const id of this.queue.ids()) this.queue.remove(id)
  }

  // ---- internal ----
  /** Antrean serial agar dua attach bersamaan tidak melewati batas. */
  private admit(nodeId: string): Promise<boolean> {
    const run = this.gate.then(() => this.admitNow(nodeId))
    this.gate = run
    return run
  }

  private async admitNow(nodeId: string): Promise<boolean> {
    if (this.queue.get(nodeId)) { this.queue.setVisible(nodeId, true, this.now()); this.cancel(nodeId); return true }
    const { maxLive } = this.deps
    const limit = typeof maxLive === 'function' ? maxLive() : maxLive
    // A lowered limit can leave several nodes over it: evict hidden ones (never a visible/driven/loading one) until one slot is free.
    while (this.queue.size >= limit) {
      const victim = this.queue.oldestHidden((id) => !this.deps.host.isLoading(id) && !this.deps.driven(id))
      if (victim === undefined || !(await this.evict(victim))) return false
    }
    this.queue.add(nodeId)
    return true
  }

  private async evict(nodeId: string): Promise<boolean> {
    try {
      await this.deps.host.stopScreencast(nodeId)
      await this.deps.host.discard(nodeId)
      this.forget(nodeId)
      return true
    } catch (err) {
      log.warn('browser.evict', 'evict for max_live failed', { ids: { nodeId }, error: errMsg(err) })
      return false
    }
  }

  private arm(nodeId: string, ms: number): void {
    this.timers.set(nodeId, this.setTimer(() => { this.timers.delete(nodeId); void this.onTimer(nodeId) }, ms))
  }

  private cancel(nodeId: string): void {
    const h = this.timers.get(nodeId)
    if (h === undefined) return
    this.clearTimer(h)
    this.timers.delete(nodeId)
  }

  /** Baca ulang kondisi saat timer MENYALA; belum layak -> jadwalkan lagi. */
  private async onTimer(nodeId: string): Promise<void> {
    const e = this.queue.get(nodeId)
    if (this.disposed || !e || e.visible || e.hiddenSince === null) return
    const hiddenMs = this.now() - e.hiddenSince
    const { discardMs, host } = this.deps
    if (!shouldDiscard({ loading: host.isLoading(nodeId), driven: this.deps.driven(nodeId), hiddenMs, discardMs })) {
      this.arm(nodeId, hiddenMs < discardMs ? discardMs - hiddenMs : this.retryMs)
      return
    }
    this.forget(nodeId)
    try {
      await host.discard(nodeId)
    } catch (err) {
      log.warn('browser.discard', 'discard failed', { ids: { nodeId }, error: errMsg(err) })
    }
  }
}
