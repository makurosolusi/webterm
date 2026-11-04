// BrowserHost: implementasi `BrowserHostApi` di atas CDP. Satu koneksi CDP per workspace (satu proses
// Chromium per profil), satu target per node. Chromium nyata tidak dijalankan di test: koneksi & peluncur diinjeksi.
import { TOUCH_POINTS_MAX, BlockedError } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserInputEvent, BrowserState, Frame, NAV_ACTIONS } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, CdpClient } from './cdp.client'
import type { CdpHandler } from './cdp.client'
import { LaunchError } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'
import { metricsParams, screencastParams, toCdpCommands } from './browserHost.input'
import { createEventRouter } from './browserHost.events'
import { blockOf, BrowserError, createPageTarget, mergeState, newRec, notePendingInput, readHistory, setupConnection, TargetTable } from './browserHost.targets'
import type { HostEvent, NavGuard, NodeRec } from './browserHost.targets'

export { BrowserError } from './browserHost.targets'
export type { HostEvent, NavGuard } from './browserHost.targets'

const log = createLogger('browser.host')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface HostDeps {
  launcher: BrowserLauncher
  guard: NavGuard
  /** Default `CdpClient.connect`; test menyuntik server CDP tiruan. */
  connect?: (wsUrl: string) => Promise<CdpClient>
}

export class BrowserHost implements BrowserHostApi {
  private readonly table = new TargetTable()
  private readonly conns = new Map<string, Promise<CdpClient>>()
  private readonly opening = new Map<string, Promise<BrowserState>>()
  private readonly stateCbs = new Set<(s: BrowserState) => void>()
  private readonly eventCbs = new Set<(e: HostEvent) => void>()

  private readonly route: CdpHandler

  constructor(private readonly deps: HostDeps) {
    this.route = createEventRouter({
      table: this.table, guard: deps.guard,
      patch: (r, p) => this.patch(r, p), emit: (e) => this.emit(e), crash: (r) => this.crash(r),
      refresh: (r) => this.refresh(r), fire: (r, m, p) => this.fire(r, m, p),
      navigate: (id, url) => this.navigate(id, url),
      closeTarget: async (r, targetId) => { await (await this.cdpOf(r)).send(CDP.closeTarget, { targetId }) },
    })
  }

  // ---- BrowserHostApi ----
  open(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState> {
    const inflight = this.opening.get(nodeId)
    if (inflight) return inflight
    const p = this.doOpen(nodeId, workspaceId, url).finally(() => this.opening.delete(nodeId))
    this.opening.set(nodeId, p)
    return p
  }

  async navigate(nodeId: string, url: string): Promise<void> {
    const rec = this.table.nodes.get(nodeId)
    if (!rec) throw new BrowserError('not_found', `navigate: unknown node ${nodeId}`)
    const blocked = this.blockOf(url)
    if (blocked) {
      this.patch(rec, { blocked: blocked.reason })
      throw new BlockedError(blocked.reason, blocked.host)
    }
    if (!rec.sessionId) await this.open(nodeId, rec.workspaceId, url)
    else await this.goto(rec, url)
  }

  async setViewport(nodeId: string, w: number, h: number, dpr: number): Promise<void> {
    const rec = this.need(nodeId)
    const prev = rec.viewport
    rec.viewport = { w, h, dpr }
    await this.send(rec, CDP.setDeviceMetrics, metricsParams(w, h, dpr))
    this.fire(rec, CDP.setVisibleSize, { width: Math.round(w), height: Math.round(h) }) // Orca ...-device-metrics.ts:45-54
    const p = screencastParams(rec.viewport) // batas frame ikut ukuran baru: restart (DevTools ScreencastView: stop/start)
    if (!rec.cast || JSON.stringify(screencastParams(prev)) === JSON.stringify(p)) return
    await this.send(rec, CDP.stopScreencast)
    await this.send(rec, CDP.startScreencast, p)
  }

  async startScreencast(nodeId: string, onFrame: (f: Frame) => void): Promise<void> {
    const rec = this.need(nodeId)
    rec.cast = { onFrame, seq: 0, acks: new Map() }
    await this.send(rec, CDP.startScreencast, screencastParams(rec.viewport))
  }

  async stopScreencast(nodeId: string): Promise<void> {
    const rec = this.table.nodes.get(nodeId)
    if (!rec?.cast) return
    rec.cast = undefined
    if (rec.sessionId) await this.send(rec, CDP.stopScreencast)
  }

  ackFrame(nodeId: string, seq: number): void {
    const rec = this.table.nodes.get(nodeId)
    const ackId = rec?.cast?.acks.get(seq)
    if (!rec || ackId === undefined) return // seq tak dikenal/basi: tidak ada yang di-ack
    rec.cast?.acks.delete(seq)
    this.fire(rec, CDP.screencastFrameAck, { sessionId: ackId })
  }

  async input(nodeId: string, ev: BrowserInputEvent): Promise<void> {
    const rec = this.need(nodeId)
    const rx = ev.ls === undefined ? 0 : Date.now() // cap terima server (I1-d); jalur langsung gateway = saat pesan tiba
    if (ev.t === 'touch' && !rec.touch) {
      await this.send(rec, CDP.setTouchEmulation, { enabled: true, maxTouchPoints: TOUCH_POINTS_MAX })
      rec.touch = true
    }
    // DevTools InputModel.ts:72,89 (`void invoke_dispatchMouseEvent`): tak menunggu balasan (wheel dibalas setelah renderer
    // memprosesnya; await = burst trackpad telat detik). Urutan dijaga satu socket CDP; galat dilog `fire`.
    for (const c of toCdpCommands(ev)) this.fire(rec, c.method, c.params)
    if (ev.ls !== undefined) notePendingInput(rec, ev.ls, rx, Date.now())
  }

  /** Jalur CDP generik; hanya dipanggil lewat `cdpAllowlist` (WS-07). */
  cdp(nodeId: string, method: string, params?: object): Promise<unknown> {
    return this.send(this.need(nodeId), method, params)
  }

  async discard(nodeId: string): Promise<void> {
    const rec = this.table.nodes.get(nodeId)
    if (!rec?.sessionId) return
    const targetId = rec.targetId as string
    const cdp = await this.conns.get(rec.workspaceId)
    this.table.unbind(rec) // unbind dulu: targetDestroyed berikutnya bukan crash
    this.patch(rec, { live: 'discarded', loading: false })
    try {
      await cdp?.send(CDP.closeTarget, { targetId })
    } catch (err) {
      log.warn('browser.discard', 'closeTarget failed (target may already be gone)', { ids: { nodeId }, error: errMsg(err) })
    }
  }

  state(nodeId: string): BrowserState | undefined {
    const rec = this.table.nodes.get(nodeId)
    return rec && { ...rec.state }
  }

  onState(cb: (s: BrowserState) => void): () => void {
    this.stateCbs.add(cb)
    return () => { this.stateCbs.delete(cb) }
  }

  isLoading(nodeId: string): boolean { return this.table.nodes.get(nodeId)?.state.loading ?? false }

  // ---- Tambahan di luar BrowserHostApi (dipakai gateway WS-04; lihat laporan) ----
  /** Dengarkan dialog JS dan galat node (crash). */
  onEvent(cb: (e: HostEvent) => void): () => void {
    this.eventCbs.add(cb)
    return () => { this.eventCbs.delete(cb) }
  }

  /** Jawab dialog JS yang sedang terbuka. */
  async answerDialog(nodeId: string, accept: boolean, text?: string): Promise<void> {
    await this.send(this.need(nodeId), CDP.handleDialog, { accept, promptText: text })
  }

  /** Aksi nav non-URL (`go` memakai `navigate`). */
  async navAction(nodeId: string, action: (typeof NAV_ACTIONS)[number], url?: string): Promise<void> {
    if (action === 'go') {
      if (!url) throw new BrowserError('bad_request', `nav go without url for node ${nodeId}`)
      return this.navigate(nodeId, url)
    }
    const rec = this.need(nodeId)
    if (action === 'reload') { await this.send(rec, CDP.reload); return }
    if (action === 'stop') { await this.send(rec, CDP.stopLoading); return }
    const h = await readHistory(await this.cdpOf(rec), rec.sessionId as string)
    const entryId = action === 'back' ? h.entryIds.prev : h.entryIds.next
    if (entryId !== undefined) await this.send(rec, CDP.navigateToHistoryEntry, { entryId })
  }

  /** Teks seleksi halaman (untuk aksi `copy`). */
  async selectionText(nodeId: string): Promise<string> {
    const r = await this.send<{ result?: { value?: unknown } }>(this.need(nodeId), CDP.evaluate, { expression: 'String(window.getSelection())', returnByValue: true })
    return typeof r.result?.value === 'string' ? r.result.value : ''
  }

  /** Tutup semua koneksi CDP (proses Chromium dimatikan oleh `launcher.shutdown()`). */
  async dispose(): Promise<void> {
    const all = [...this.conns.values()]
    this.conns.clear()
    for (const p of all) (await p.catch(() => null))?.close() // koneksi yang gagal dibuat tidak perlu ditutup
  }

  // ---- internal ----
  private blockOf(url: string) { return blockOf(this.deps.guard, url) }

  private async doOpen(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState> {
    let rec = this.table.nodes.get(nodeId)
    if (rec?.sessionId) return { ...rec.state }
    if (!rec) this.table.nodes.set(nodeId, (rec = newRec(nodeId, workspaceId, url ?? '')))
    rec.workspaceId = workspaceId
    const target = url ?? rec.state.url
    const blocked = target ? this.blockOf(target) : null
    let cdp: CdpClient
    try {
      cdp = await this.connection(workspaceId)
    } catch (err) {
      const noBin = err instanceof LaunchError && err.code === 'no_binary'
      if (noBin) this.patch(rec, { blocked: 'no_binary' })
      throw new BrowserError(noBin ? 'no_binary' : 'crashed', `open node ${nodeId} failed: ${errMsg(err)}`, undefined, err)
    }
    const { targetId, sessionId } = await createPageTarget(cdp, rec.viewport)
    this.table.bind(rec, targetId, sessionId)
    this.patch(rec, { live: 'live', blocked: blocked?.reason, url: target })
    if (target && !blocked) await this.goto(rec, target)
    return { ...rec.state }
  }

  private connection(workspaceId: string): Promise<CdpClient> {
    let p = this.conns.get(workspaceId)
    if (!p) {
      p = (async () => {
        const wsUrl = await this.deps.launcher.acquire(workspaceId)
        const cdp = await (this.deps.connect ?? ((u: string) => CdpClient.connect(u)))(wsUrl)
        cdp.on('*', this.route)
        cdp.onClose((err) => this.onConnClosed(workspaceId, err))
        try {
          await setupConnection(cdp)
        } catch (err) {
          cdp.close()
          throw err
        }
        return cdp
      })()
      this.conns.set(workspaceId, p)
      p.catch(() => this.conns.delete(workspaceId)) // lemparan tetap sampai ke pemanggil connection()
    }
    return p
  }

  private onConnClosed(workspaceId: string, err: Error): void {
    this.conns.delete(workspaceId)
    log.warn('browser.conn', 'cdp connection closed', { ids: { workspaceId }, error: err.message })
    for (const rec of this.table.nodes.values()) if (rec.workspaceId === workspaceId) this.crash(rec)
  }

  private need(nodeId: string): NodeRec {
    const rec = this.table.nodes.get(nodeId)
    if (!rec?.sessionId) throw new BrowserError('not_found', `node ${nodeId} has no live browser target`)
    return rec
  }

  private async cdpOf(rec: NodeRec): Promise<CdpClient> {
    const cdp = await this.conns.get(rec.workspaceId)
    if (!cdp || cdp.closed) throw new BrowserError('crashed', `node ${rec.nodeId}: browser connection is gone`)
    return cdp
  }

  private async send<T = Record<string, unknown>>(rec: NodeRec, method: string, params?: object): Promise<T> {
    if (!rec.sessionId) throw new BrowserError('not_found', `node ${rec.nodeId} has no live browser target`)
    return (await this.cdpOf(rec)).send<T>(method, params, rec.sessionId)
  }

  /** Kirim tanpa menunggu; kegagalan dilog (mis. target sudah hilang), tidak melempar ke pemanggil. */
  private fire(rec: NodeRec, method: string, params?: object): void {
    this.send(rec, method, params).catch((err) => log.warn('browser.cdp', 'fire-and-forget failed', { ids: { nodeId: rec.nodeId }, method, error: errMsg(err) }))
  }

  private async goto(rec: NodeRec, url: string): Promise<void> {
    const r = await this.send<{ errorText?: string }>(rec, CDP.navigate, { url })
    if (r.errorText) log.warn('browser.nav', 'navigation failed', { ids: { nodeId: rec.nodeId }, host: hostOnly(url), error: r.errorText })
  }

  private patch(rec: NodeRec, part: Partial<BrowserState>): void {
    const next = mergeState(rec.state, part)
    if (!next) return
    rec.state = next
    for (const cb of this.stateCbs) this.safe(() => cb({ ...next }))
  }

  private emit(e: HostEvent): void {
    for (const cb of this.eventCbs) this.safe(() => cb(e))
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      log.error('browser.listener', 'listener threw', { error: errMsg(err) })
    }
  }

  private crash(rec: NodeRec): void {
    if (!rec.sessionId) return
    this.table.unbind(rec)
    this.patch(rec, { live: 'discarded', loading: false })
    this.emit({ k: 'error', nodeId: rec.nodeId, code: 'crashed' })
    log.warn('browser.crash', 'browser target lost', { ids: { nodeId: rec.nodeId } })
  }

  private async refresh(rec: NodeRec): Promise<void> {
    const sid = rec.sessionId
    if (!sid) return
    try {
      const h = await readHistory(await this.cdpOf(rec), sid)
      if (rec.sessionId === sid) this.patch(rec, { title: h.title, canBack: h.canBack, canForward: h.canForward })
    } catch (err) {
      log.warn('browser.history', 'history read failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) })
    }
  }
}
