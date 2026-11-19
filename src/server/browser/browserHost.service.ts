// BrowserHost: implementasi `BrowserHostApi` di atas CDP. Satu koneksi CDP per workspace (satu proses
// Chromium per profil), satu target per node. Chromium nyata tidak dijalankan di test: koneksi & peluncur diinjeksi.
import { TOUCH_POINTS_MAX, BlockedError } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserInputEvent, BrowserState, Frame, NAV_ACTIONS } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, ignoreClosed, isTargetGone } from './cdp.client'
import type { CdpClient, CdpHandler } from './cdp.client'
import { screencastParams, toCdpCommands } from './browserHost.input'
import { startCast, stopCast } from './browserHost.cast'
import { castViewport, resizeViewport, setDevice, type DeviceChoice, type DeviceIo } from './browserHost.device'
import { createEventRouter } from './browserHost.events'
import { createShieldRouter } from './browserHost.shield'
import type { ShieldRouter } from './browserHost.shield'
import type { HostDeps } from './browserHost.deps'
import { createConsoleLog } from './browserHost.console'
import { createChallengeTracker } from './browserHost.challenge'
import { createHostContainment, type Containment } from './browserHost.containment'
import { createContextMenu, type ContextMenu } from './browserHost.contextMenu'
import { createTargetLifecycle } from './browserHost.lifecycle'
import { createTabs } from './browserHost.tabs'
import type { TabManager } from './browserHost.tabs'
import { createTabApi } from './browserHost.tabs.api'
import { gotoPage, selectedText, stepPage } from './browserHost.page'
import type { PageIo } from './browserHost.page'
import { createSync } from './browserHost.sync'
import type { NodeSync } from './browserHost.sync'
import type { TabApi } from './browserHost.tabs.api'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import type { TargetLifecycle } from './browserHost.lifecycle'
import { blockOf, BrowserError, mergeState, notePendingInput, readHistory, TargetGoneError, TargetTable } from './browserHost.targets'
import type { HostEvent, NavGuard, NodeRec } from './browserHost.targets'

export { BrowserError, TargetGoneError, type HostEvent, type NavGuard } from './browserHost.targets'

const log = createLogger('browser.host')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type { HostDeps } from './browserHost.deps'

export class BrowserHost implements BrowserHostApi {
  private readonly table = new TargetTable()
  private readonly pageIo: PageIo = { send: (r, m, p) => this.send(r, m, p), cdpOf: (r) => this.cdpOf(r) }
  private readonly challenges = createChallengeTracker()
  private readonly stateCbs = new Set<(s: BrowserState) => void>()
  private readonly eventCbs = new Set<(e: HostEvent) => void>()

  private readonly route: CdpHandler
  private readonly shield: ShieldRouter
  private readonly life: TargetLifecycle
  private readonly contain: Containment // pages Chromium opens by itself are moved into a tab of their node or closed
  private readonly tabs: TabManager
  /** Tabs of a node (list, actions, per-tab CDP for the agent); see browserHost.tabs.api.ts. */
  readonly tabApi: TabApi
  /** Sync mode: a human action in one pane repeated in the others (browserHost.sync.ts). */
  readonly sync: NodeSync
  readonly ctxMenu: ContextMenu // right click = the canvas's own menu, never Chromium's native one: `input` drops the right button
  readonly console = createConsoleLog({ table: this.table, send: (r, m, p) => this.send(r, m, p), now: () => (this.deps.now ?? Date.now)() }) // console panel + agent `console` verb

  constructor(private readonly deps: HostDeps) {
    const patch = (r: NodeRec, p: Partial<BrowserState>) => this.patch(r, p)
    const emit = (e: HostEvent) => this.emit(e)
    this.shield = createShieldRouter({ table: this.table, policy: deps.shields, patch, emit, now: deps.now })
    this.tabs = createTabs({
      table: this.table, guard: deps.guard, cdpOf: (r) => this.cdpOf(r), patch, emit, io: (r) => this.io(r), shield: this.shield, console: this.console,
      refresh: (r) => this.refresh(r), initialTabs: deps.initialTabs, persist: deps.persistTabs, agentDriving: deps.agentDriving, discardMs: deps.tabDiscardMs,
    })
    this.tabApi = createTabApi({ table: this.table, tabs: this.tabs, guard: deps.guard, cdpOf: (r) => this.cdpOf(r), patch })
    this.sync = createSync({ table: this.table, tabApi: this.tabApi, emit })
    this.ctxMenu = createContextMenu({ cdpOf: (r) => this.cdpOf(r), emit, now: deps.now ?? Date.now, newTab: (n, q) => this.tabApi.newTab(n, q), sessionOf: async (r, t) => (t && r.tabs && t !== r.tabs.state.activeTabId ? this.tabs.liveSession(r, t) : r.sessionId) })
    this.contain = createHostContainment({ table: this.table, cdpOf: (r) => this.cdpOf(r), popupAllowed: (r, u) => this.shield.popupAllowed(r, u), newTab: (n, q) => this.tabApi.newTab(n, q), emit, now: deps.now, graceMs: deps.containGraceMs })
    this.route = createEventRouter({
      table: this.table, guard: deps.guard, patch, emit, crash: (r) => this.life.crash(r),
      refresh: (r) => this.refresh(r), fire: (r, m, p) => this.fire(r, m, p),
      closeTarget: async (r, targetId) => { await (await this.cdpOf(r)).send(CDP.closeTarget, { targetId }) },
      popup: (r, url) => this.shield.popupAllowed(r, url), adopt: (r, o, t, u) => this.tabApi.run(r.nodeId, () => this.tabs.adoptPopup(r, o, t, u)),
      closed: (r, t) => {
        if (!this.tabs.closedTab(r, t)) return false
        this.tabApi.run(r.nodeId, () => this.tabs.pageClosed(r, t)).catch((err) => log.warn('browser.tabs', 'removing the tab of a closed page failed', { ids: { nodeId: r.nodeId }, error: errMsg(err) }))
        return true
      },
      bgEvent: (b, m, p, sid) => this.tabs.bgEvent(b, m, p, sid), bgTitle: (b, t) => this.tabs.bgTitle(b, t), bgGone: (b) => this.tabs.bgGone(b), binding: (r, p) => this.tabs.binding(r, p),
      pageState: (url) => this.shield.pageState(url),
      detached: (p) => this.shield.detached(p), stray: (i) => this.contain.stray(i), gone: (t) => this.contain.gone(t),
    })
    this.life = createTargetLifecycle({
      table: this.table, launcher: deps.launcher, profileOf: deps.profileOf, guard: deps.guard, connect: deps.connect, initialDevice: deps.initialDevice, downloads: deps.downloads, now: deps.now,
      shield: this.shield, console: this.console, route: this.route, tabs: this.tabs, patch, emit,
      io: (r) => this.io(r), goto: (r, url) => this.goto(r, url),
    })
  }

  get downloads() { return this.life.downloads } // list/cancel/remove/export of the nodes' downloads; undefined = denied (browserHost.downloads.ts)
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

  /** Start/stop run in the node's tab action queue, so a viewer joining cannot interleave with a tab switch (one view session at a time). */
  startScreencast(nodeId: string, onFrame: (f: Frame) => void): Promise<void> {
    return this.tabApi.run(nodeId, async () => {
      const rec = this.need(nodeId)
      rec.cast = { onFrame, seq: 0, acks: new Map() }
      await startCast((m, p) => this.send(rec, m, p), screencastParams(castViewport(rec)), `node ${nodeId}`)
      if (rec.tabs?.split?.visible.length) await this.tabs.split.reconcile(rec) // start the other panes too
    })
  }

  stopScreencast(nodeId: string): Promise<void> {
    return this.tabApi.run(nodeId, async () => {
      const rec = this.table.nodes.get(nodeId)
      if (!rec?.cast) return
      await this.tabs.split.stopAll(rec)
      rec.cast = undefined
      if (rec.sessionId) await stopCast((m, p) => this.send(rec, m, p), `node ${nodeId}`)
    })
  }

  ackFrame(nodeId: string, seq: number): void {
    const rec = this.table.nodes.get(nodeId)
    if (rec?.cast?.sides?.has(seq)) { this.tabs.split.ackSide(rec, seq); return }
    const ackId = rec?.cast?.acks.get(seq)
    if (!rec || ackId === undefined) return // seq tak dikenal/basi: tidak ada yang di-ack
    rec.cast?.acks.delete(seq)
    this.fire(rec, CDP.screencastFrameAck, { sessionId: ackId })
  }

  async input(nodeId: string, ev: BrowserInputEvent): Promise<void> {
    const rec = this.need(nodeId)
    const rx = ev.ls === undefined ? 0 : Date.now() // cap terima server (I1-d); jalur langsung gateway = saat pesan tiba
    this.contain.noteInput(nodeId, ev); if (this.ctxMenu.intercept(rec, ev)) return; if (ev.tab && rec.tabs && ev.tab !== rec.tabs.state.activeTabId) { this.tabs.split.input(rec, ev.tab, ev); if (!this.deps.agentDriving?.(nodeId)) this.sync.onInput(nodeId, ev); return }
    if (ev.t === 'touch' && !rec.touch) {
      await this.send(rec, CDP.setTouchEmulation, { enabled: true, maxTouchPoints: TOUCH_POINTS_MAX })
      rec.touch = true
    }
    // DevTools InputModel.ts:72,89 (`void invoke_dispatchMouseEvent`): tak menunggu balasan (wheel dibalas setelah renderer
    // memprosesnya; await = burst trackpad telat detik). Urutan dijaga satu socket CDP; galat dilog `fire`.
    for (const c of toCdpCommands(ev)) this.fire(rec, c.method, c.params)
    if (ev.ls !== undefined) notePendingInput(rec, ev.ls, rx, Date.now())
    if (!this.deps.agentDriving?.(nodeId)) this.sync.onInput(nodeId, ev) // sync repeats what a human does; an agent uses `--all`
  }

  /** Jalur CDP generik; hanya dipanggil lewat `cdpAllowlist` (WS-07). */
  cdp(nodeId: string, method: string, params?: object): Promise<unknown> {
    return this.send(this.need(nodeId), method, params)
  }

  discard(nodeId: string): Promise<void> { return this.life.discard(nodeId) }

  /** Sync mode of a node (for the gateway's attach message). */
  syncOn(nodeId: string): boolean { return this.sync.isOn(nodeId) }

  /** Tab list of a node (for the gateway's attach message); undefined = no tabs yet. */
  tabsState(nodeId: string): BrowserTabsState | undefined { return this.tabApi.state(nodeId) }

  /** Workspace that owns a known node (also a discarded one); undefined = unknown to the host. */
  workspaceOf(nodeId: string): string | undefined { return this.table.nodes.get(nodeId)?.workspaceId }

  /** Profile a known node's page runs in; undefined = unknown to the host. */
  profileOf(nodeId: string): string | undefined { return this.table.nodes.get(nodeId)?.profileId }

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
  async answerDialog(nodeId: string, accept: boolean, text?: string): Promise<void> { await this.send(this.need(nodeId), CDP.handleDialog, { accept, promptText: text }) }

  /** Aksi nav non-URL (`go` memakai `navigate`); in sync mode the other panes follow once this one has gone. */
  async navAction(nodeId: string, action: (typeof NAV_ACTIONS)[number], url?: string): Promise<void> {
    await this.navOwn(nodeId, action, url)
    this.sync.onNav(nodeId, action, url)
  }

  private async navOwn(nodeId: string, action: (typeof NAV_ACTIONS)[number], url?: string): Promise<void> {
    if (action === 'go') {
      if (!url) throw new BrowserError('bad_request', `nav go without url for node ${nodeId}`)
      return this.navigate(nodeId, url)
    }
    const lost = this.table.nodes.get(nodeId)
    if (action === 'reload' && lost && !lost.sessionId) { await this.open(nodeId, lost.workspaceId, lost.state.url || undefined); return } // halaman crash: Reload memulihkan (Chrome "Aw, Snap")
    await stepPage(this.pageIo, this.need(nodeId), action)
  }

  /** Sakelar Shields untuk situs halaman node ini (dipersist per host), lalu muat ulang seperti Brave. */
  async setShields(nodeId: string, on: boolean): Promise<void> {
    const rec = this.need(nodeId)
    this.shield.toggle(rec, on)
    await this.send(rec, CDP.reload)
  }

  /** "I'm done" on a human check: the node stops flagging this page and agents may continue. */
  dismissChallenge(nodeId: string): void { const rec = this.need(nodeId); const p = this.challenges.dismiss(rec.state); if (p) this.patch(rec, p) }

  /** Teks seleksi halaman (untuk aksi `copy`). */
  async selectionText(nodeId: string): Promise<string> { return selectedText(this.pageIo, this.need(nodeId)) }

  /** Tutup semua koneksi CDP (proses Chromium dimatikan oleh `launcher.shutdown()`). */
  dispose(): Promise<void> { this.contain.dispose(); return this.life.dispose() }

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
    const sid = rec.sessionId
    if (!sid) throw new BrowserError('crashed', `node ${rec.nodeId} has no live browser target`)
    try {
      return await (await this.cdpOf(rec)).send<T>(method, params, sid)
    } catch (err) {
      if (!isTargetGone(err)) throw err
      // Balasan galat bisa tiba sebelum event detach/destroy: lepas node di sini juga, supaya `open` membuat target baru.
      if (rec.sessionId === sid) this.life.crash(rec)
      throw new TargetGoneError(`node ${rec.nodeId}: browser target is gone (${method})`, err)
    }
  }
  private io(rec: NodeRec): DeviceIo { return { send: (m, p) => this.send(rec, m, p), fire: (m, p) => this.fire(rec, m, p) } }

  /** Kirim tanpa menunggu; koneksi tertutup diabaikan, kegagalan lain dilog (`ignoreClosed`), tidak melempar ke pemanggil. */
  private fire(rec: NodeRec, method: string, params?: object): void {
    this.send(rec, method, params).catch(ignoreClosed(method, { nodeId: rec.nodeId, sessionId: rec.sessionId }))
  }

  private goto(rec: NodeRec, url: string): Promise<void> { return gotoPage(this.pageIo, this.deps.guard, (r, p) => this.patch(r, p), rec, url) }

  private patch(rec: NodeRec, raw: Partial<BrowserState>): void {
    const part = this.challenges.apply(rec.state, raw)
    const next = mergeState(rec.state, part)
    if (!next) return
    rec.state = next
    this.tabs.viewPatched(rec, part)
    for (const cb of this.stateCbs) this.safe(() => cb({ ...next }))
  }

  private emit(e: HostEvent): void {
    for (const cb of this.eventCbs) this.safe(() => cb(e))
    this.safe(() => this.sync?.onEvent(e)) // `sync` is made after the first events can fire (constructor)
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
