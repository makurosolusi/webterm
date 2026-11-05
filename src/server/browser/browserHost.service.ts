// BrowserHost: implementasi `BrowserHostApi` di atas CDP. Satu koneksi CDP per workspace (satu proses
// Chromium per profil), satu target per node. Chromium nyata tidak dijalankan di test: koneksi & peluncur diinjeksi.
import { TOUCH_POINTS_MAX, BlockedError } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserInputEvent, BrowserState, Frame, NAV_ACTIONS } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import type { CdpClient, CdpHandler } from './cdp.client'
import type { BrowserLauncher } from './chromium.launch'
import { screencastParams, toCdpCommands } from './browserHost.input'
import { castViewport, resizeViewport, setDevice, type DeviceChoice, type DeviceIo } from './browserHost.device'
import { createEventRouter } from './browserHost.events'
import { createShieldRouter } from './browserHost.shield'
import type { ShieldRouter } from './browserHost.shield'
import type { ShieldPolicy } from './adblock.shields'
import { createConsoleLog } from './browserHost.console'
import { createTargetLifecycle } from './browserHost.lifecycle'
import type { TargetLifecycle } from './browserHost.lifecycle'
import { blockOf, BrowserError, mergeState, notePendingInput, readHistory, TargetTable } from './browserHost.targets'
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
  /** Shields (blokir iklan/pelacak + sakelar per situs); tanpa ini hanya batas popup yang berlaku. */
  shields?: ShieldPolicy
  initialDevice?: (nodeId: string) => unknown // device saved on the board (`WsNode.device`): seeds a node seen first time
  now?: () => number
}

export class BrowserHost implements BrowserHostApi {
  private readonly table = new TargetTable()
  private readonly stateCbs = new Set<(s: BrowserState) => void>()
  private readonly eventCbs = new Set<(e: HostEvent) => void>()

  private readonly route: CdpHandler
  private readonly shield: ShieldRouter
  private readonly life: TargetLifecycle
  readonly console = createConsoleLog({ table: this.table, send: (r, m, p) => this.send(r, m, p), now: () => (this.deps.now ?? Date.now)() }) // console panel + agent `console` verb

  constructor(private readonly deps: HostDeps) {
    const patch = (r: NodeRec, p: Partial<BrowserState>) => this.patch(r, p)
    const emit = (e: HostEvent) => this.emit(e)
    this.shield = createShieldRouter({ table: this.table, policy: deps.shields, patch, emit, now: deps.now })
    this.route = createEventRouter({
      table: this.table, guard: deps.guard, patch, emit, crash: (r) => this.life.crash(r),
      refresh: (r) => this.refresh(r), fire: (r, m, p) => this.fire(r, m, p),
      closeTarget: async (r, targetId) => { await (await this.cdpOf(r)).send(CDP.closeTarget, { targetId }) },
      popup: (r, url) => this.shield.popup(r, url), pageState: (url) => this.shield.pageState(url),
      detached: (p) => this.shield.detached(p),
    })
    this.life = createTargetLifecycle({
      table: this.table, launcher: deps.launcher, guard: deps.guard, connect: deps.connect, initialDevice: deps.initialDevice,
      shield: this.shield, console: this.console, route: this.route, patch, emit,
      io: (r) => this.io(r), goto: (r, url) => this.goto(r, url),
    })
  }

  // ---- BrowserHostApi ----
  open(nodeId: string, workspaceId: string, url?: string): Promise<BrowserState> { return this.life.open(nodeId, workspaceId, url) }

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
    return resizeViewport(rec, { w, h, dpr }, this.io(rec))
  }

  /** Device mode (DevTools Device Toolbar): emulate a preset/custom device; null = follow the node size again. */
  async setDevice(nodeId: string, device: DeviceChoice | null): Promise<void> { const rec = this.need(nodeId); return setDevice(rec, device, this.io(rec)) }

  async startScreencast(nodeId: string, onFrame: (f: Frame) => void): Promise<void> {
    const rec = this.need(nodeId)
    rec.cast = { onFrame, seq: 0, acks: new Map() }
    await this.send(rec, CDP.startScreencast, screencastParams(castViewport(rec)))
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

  discard(nodeId: string): Promise<void> { return this.life.discard(nodeId) }

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
    const lost = this.table.nodes.get(nodeId)
    if (action === 'reload' && lost && !lost.sessionId) { await this.open(nodeId, lost.workspaceId, lost.state.url || undefined); return } // halaman crash: Reload memulihkan (Chrome "Aw, Snap")
    const rec = this.need(nodeId)
    if (action === 'reload') { await this.send(rec, CDP.reload); return }
    if (action === 'stop') { await this.send(rec, CDP.stopLoading); return }
    const h = await readHistory(await this.cdpOf(rec), rec.sessionId as string)
    const entryId = action === 'back' ? h.entryIds.prev : h.entryIds.next
    if (entryId !== undefined) await this.send(rec, CDP.navigateToHistoryEntry, { entryId })
  }

  /** Sakelar Shields untuk situs halaman node ini (dipersist per host), lalu muat ulang seperti Brave. */
  async setShields(nodeId: string, on: boolean): Promise<void> {
    const rec = this.need(nodeId)
    this.shield.toggle(rec, on)
    await this.send(rec, CDP.reload)
  }

  /** Teks seleksi halaman (untuk aksi `copy`). */
  async selectionText(nodeId: string): Promise<string> {
    const r = await this.send<{ result?: { value?: unknown } }>(this.need(nodeId), CDP.evaluate, { expression: 'String(window.getSelection())', returnByValue: true })
    return typeof r.result?.value === 'string' ? r.result.value : ''
  }

  /** Tutup semua koneksi CDP (proses Chromium dimatikan oleh `launcher.shutdown()`). */
  dispose(): Promise<void> { return this.life.dispose() }

  // ---- internal ----
  private blockOf(url: string) { return blockOf(this.deps.guard, url) }

  /**
   * Node dengan target hidup. Node dikenal yang targetnya hilang (crash/putus) = `crashed`, bukan `not_found`:
   * dulu tiap klik sesudah crash menimpa "The page crashed. Reload…" dengan "This browser session no longer exists."
   */
  private need(nodeId: string): NodeRec {
    const rec = this.table.nodes.get(nodeId)
    if (!rec) throw new BrowserError('not_found', `node ${nodeId} is unknown to the browser host`)
    if (!rec.sessionId) throw new BrowserError('crashed', `node ${nodeId} has no live browser target`)
    return rec
  }

  private cdpOf(rec: NodeRec): Promise<CdpClient> { return this.life.cdpOf(rec) }

  private async send<T = Record<string, unknown>>(rec: NodeRec, method: string, params?: object): Promise<T> {
    if (!rec.sessionId) throw new BrowserError('crashed', `node ${rec.nodeId} has no live browser target`)
    return (await this.cdpOf(rec)).send<T>(method, params, rec.sessionId)
  }
  private io(rec: NodeRec): DeviceIo { return { send: (m, p) => this.send(rec, m, p), fire: (m, p) => this.fire(rec, m, p) } }

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
    try { fn() } catch (err) { log.error('browser.listener', 'listener threw', { error: errMsg(err) }) }
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
