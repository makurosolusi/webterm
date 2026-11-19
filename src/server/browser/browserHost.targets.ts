// Tabel target per node + operasi target tingkat rendah (buat/attach/riwayat/setup koneksi).
// Tidak menyimpan kebijakan; `BrowserHost` yang memutuskan kapan memanggil.
import { INPUT_LATENCY_STALE_MS } from '../../shared/browser.contract'
import type { BlockReason, BrowserErrorCode, BrowserState, Frame, FrameLatency, LaunchReason } from '../../shared/browser.contract'
import { hostOnly, parseBrowserUrl } from '../../shared/browser.url'
import type { DeviceSpec } from '../../shared/browser.devices'
import type { BrowserTabEvent, BrowserTabsState } from '../../shared/browser.tabs'
import type { DownloadItem } from '../../shared/browser.downloads'
import { DEFAULT_VIEWPORT, DENIED_PERMISSIONS, windowPlacement } from './chromium.flags'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { metricsParams } from './browserHost.input'
import { markOwnTarget } from './browserHost.containment'

/** Galat host ber-kode; gateway memetakan `code` ke `{t:'error'}` (tanpa URL, hanya hostname). */
export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string, readonly hostname?: string, cause?: unknown, readonly reason?: LaunchReason) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BrowserError'
  }
}

/** Target node hilang di bawah perintah (detach/tukar/tutup tanpa event); node sudah dilepas, `open` berikutnya membuat target baru. */
export class TargetGoneError extends BrowserError {
  constructor(message: string, cause?: unknown) {
    super('crashed', message, undefined, cause)
    this.name = 'TargetGoneError'
  }
}

/**
 * Event di luar `BrowserHostApi`: dialog JS (jawab lewat `answerDialog`), galat tingkat node (mis. crash), dan
 * tab (daftar tab node berubah / ditolak). Popup sah menjadi tab baru di node pembukanya (`browserHost.tabs.popup.ts`).
 */
export type HostEvent =
  | { k: 'dialog'; nodeId: string; kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string }
  | { k: 'error'; nodeId: string; code: BrowserErrorCode; hostname?: string }
  | { k: 'tab'; nodeId: string; event: BrowserTabEvent }
  | { k: 'tabNotice'; nodeId: string; message: string }
  /** A download of the node changed (begun, progress, ended); `downloads` = its whole list changed (an entry was removed). */
  | { k: 'download'; nodeId: string; item: DownloadItem }
  | { k: 'downloads'; nodeId: string; items: DownloadItem[] }
  /** Sync mode (browserHost.sync.ts) turned on/off for the node; `syncMiss` = the pane `tab` found no element matching the one acted on. */
  | { k: 'sync'; nodeId: string; on: boolean }
  | { k: 'syncMiss'; nodeId: string; tab: string; reason: 'no_match' | 'cross_origin' | 'error' }

export { DEFAULT_VIEWPORT }

/** Runtime ids of one tab's CDP target; absent = the tab is discarded or crashed (no page). */
export interface TabRt { targetId?: string; sessionId?: string }

/**
 * Tab model of one node. Invariant while the node is live: `rec.targetId/sessionId` are the target of `state.activeTabId`
 * (the human's view, the only one that streams); every other live tab sits in `table` as a background tab.
 */
export interface NodeTabs {
  state: BrowserTabsState
  rt: Map<string, TabRt>
  /** True until the human picks a tab themselves: tabs an agent-driven click opens then move the human's view too. */
  followAgent: boolean
  /** Page left over after the last tab was closed (the node shows it blank); the next new tab reuses it. */
  blank?: TabRt
  /** Split-view runtime (browserHost.split.ts); created on first use. */
  split?: SplitRt
}

/**
 * What a split view adds to a node's tabs: the tabs on screen, a screencast per on-screen tab that is not the view
 * (`side`, keyed by tab id), per-tab pane sizes, and what is already applied to each page (emulation, stream parameters).
 */
export interface SplitRt {
  visible: string[]
  side: Map<string, { sessionId: string }>
  vp: Map<string, { w: number; h: number; dpr: number }>
  applied: Map<string, string>
  castKey: Map<string, string>
  identity: Map<string, string>
  touch: Set<string>
  tail: Promise<unknown>
}

/** A background tab of a node (not the view). */
export interface BgTab { rec: NodeRec; tabId: string }

export interface NodeRec {
  nodeId: string
  workspaceId: string
  /** Profile (= Chromium process + session) the node's page lives in; see `resolveProfileId`. */
  profileId: string
  targetId?: string
  sessionId?: string
  state: BrowserState
  viewport: { w: number; h: number; dpr: number }
  /** `acks`: seq milik kita -> id ack screencast milik Chromium (dikirim hanya setelah `ackFrame`). */
  cast?: { onFrame: (f: Frame) => void; seq: number; acks: Map<number, number>; /** seq -> session of a frame from an on-screen tab that is not the view (ack goes there). */ sides?: Map<number, string> }
  touch: boolean
  /** Device mode (browserHost.device.ts): spec = emulated device, null = Responsive, undefined = not seeded from the board yet. */
  device?: DeviceSpec | null
  /** Input bercap waktu PERTAMA yang belum terjawab frame (I1-d); `rx`/`dispatched` = jam server, ms epoch. */
  lat?: { ls: number; rx: number; dispatched: number }
  /** Tabs of the node (browserHost.tabs.ts); set when the node's page first opens. */
  tabs?: NodeTabs
}

export function newRec(nodeId: string, workspaceId: string, url: string, profileId: string = workspaceId): NodeRec {
  return {
    nodeId, workspaceId, profileId, touch: false, viewport: { ...DEFAULT_VIEWPORT },
    state: { id: nodeId, url, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'discarded' },
  }
}

/** Indeks node dan lookup cepat dari event CDP (sessionId/targetId). */
export class TargetTable {
  readonly nodes = new Map<string, NodeRec>()
  private readonly bySession = new Map<string, NodeRec>()
  private readonly byTarget = new Map<string, NodeRec>()
  bind(rec: NodeRec, targetId: string, sessionId: string): void {
    rec.targetId = targetId
    rec.sessionId = sessionId
    this.byTarget.set(targetId, rec)
    this.bySession.set(sessionId, rec)
  }
  unbind(rec: NodeRec): void {
    if (rec.targetId) this.byTarget.delete(rec.targetId)
    if (rec.sessionId) this.bySession.delete(rec.sessionId)
    rec.targetId = rec.sessionId = undefined
    rec.cast = undefined
    rec.touch = false
  }
  session(id: string | undefined): NodeRec | undefined { return id ? this.bySession.get(id) : undefined }
  target(id: unknown): NodeRec | undefined { return typeof id === 'string' ? this.byTarget.get(id) : undefined }

  private readonly bgSessions = new Map<string, BgTab>()
  private readonly bgTargets = new Map<string, BgTab>()
  /** Register a live tab that is not the view. */
  bgBind(rec: NodeRec, tabId: string, targetId: string, sessionId: string): void {
    const b = { rec, tabId }
    this.bgTargets.set(targetId, b)
    this.bgSessions.set(sessionId, b)
  }
  bgUnbind(targetId: string | undefined, sessionId: string | undefined): void {
    if (targetId) this.bgTargets.delete(targetId)
    if (sessionId) this.bgSessions.delete(sessionId)
  }
  bgSession(id: string | undefined): BgTab | undefined { return id ? this.bgSessions.get(id) : undefined }
  bgTarget(id: unknown): BgTab | undefined { return typeof id === 'string' ? this.bgTargets.get(id) : undefined }
  /** Point the node's view at another target (the old one is unbound from the view only; the caller decides its fate). */
  rebind(rec: NodeRec, targetId: string, sessionId: string): void {
    if (rec.targetId) this.byTarget.delete(rec.targetId)
    if (rec.sessionId) this.bySession.delete(rec.sessionId)
    this.bgUnbind(targetId, sessionId)
    this.bind(rec, targetId, sessionId)
  }
}

/**
 * Setup sekali per koneksi browser: temukan target (popup), atur download + tolak izin perangkat. Download: with a folder,
 * Chromium saves into it under the download's guid and reports events (the host renames it); without one (no download wiring) it is denied.
 */
export async function setupConnection(cdp: CdpClient, downloadPath?: string): Promise<void> {
  await cdp.send(CDP.setDiscoverTargets, { discover: true })
  await cdp.send(CDP.setDownloadBehavior, downloadPath ? { behavior: 'allowAndName', downloadPath, eventsEnabled: true } : { behavior: 'deny' })
  for (const name of DENIED_PERMISSIONS) {
    await cdp.send(CDP.setPermission, { permission: { name }, setting: 'denied' })
  }
}

/** Buat jendela kosong di latar (windowPlacement), attach (flatten), aktifkan Page, pasang viewport awal. */
export async function createPageTarget(cdp: CdpClient, vp: NodeRec['viewport']): Promise<{ targetId: string; sessionId: string }> {
  const { targetId } = await cdp.send<{ targetId: string }>(CDP.createTarget, { url: 'about:blank', ...windowPlacement() })
  markOwnTarget(targetId) // ours from the first instant: the containment guard must not take it for a stray
  const { sessionId } = await cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
  await cdp.send(CDP.pageEnable, {}, sessionId)
  await cdp.send(CDP.setDeviceMetrics, metricsParams(vp.w, vp.h, vp.dpr), sessionId)
  // Jendela offscreen/minimized (atau headless fallback) tak pernah punya fokus OS; tanpa emulasi Chrome menganggap
  // halaman tak fokus. Tab sudah aktif di jendelanya sendiri, jadi TANPA Page.bringToFront: di macOS itu memulihkan
  // jendela minimized dan mencuri fokus (diukur).
  await cdp.send(CDP.setFocusEmulation, { enabled: true }, sessionId)
  return { targetId, sessionId }
}

/** Posisi riwayat navigasi: judul + bisa mundur/maju (dan id entri tetangga untuk back/forward). */
export async function readHistory(cdp: CdpClient, sessionId: string): Promise<{ title: string; canBack: boolean; canForward: boolean; entryIds: { prev?: number; next?: number } }> {
  const h = await cdp.send<{ currentIndex: number; entries: Array<{ id: number; title: string }> }>(CDP.getNavigationHistory, {}, sessionId)
  const cur = h.entries[h.currentIndex]
  return {
    title: cur?.title ?? '',
    canBack: h.currentIndex > 0,
    canForward: h.currentIndex < h.entries.length - 1,
    entryIds: { prev: h.entries[h.currentIndex - 1]?.id, next: h.entries[h.currentIndex + 1]?.id },
  }
}

/** Penjaga navigasi (diimplementasikan WS-02 `navigation.guard`); null = lolos. Tanpa DNS. */
export interface NavGuard {
  check(url: string): BlockReason | null
  onFrameNavigated(url: string): BlockReason | null
}

/** Skema + penjaga untuk URL dari luar; null = boleh. `host` hanya hostname (aman-log). */
export function blockOf(guard: NavGuard, url: string): { reason: BlockReason; host: string } | null {
  const p = parseBrowserUrl(url)
  if (!p.ok) return { reason: 'scheme', host: hostOnly(url) }
  const reason = guard.check(p.url)
  return reason ? { reason, host: p.host } : null
}

/** `Page.screencastFrame` -> `Frame` bernomor milik kita (uint32 melingkar); id ack Chromium disimpan untuk `ackFrame`. */
export function pushFrame(rec: NodeRec, p: Record<string, unknown>): void {
  const cast = rec.cast
  if (!cast || typeof p.data !== 'string' || typeof p.sessionId !== 'number') return
  cast.seq = (cast.seq + 1) >>> 0
  cast.acks.set(cast.seq, p.sessionId)
  const jpeg = Buffer.from(p.data, 'base64')
  const lat = rec.lat && frameLatency(rec, p.metadata, Date.now())
  // A split view tells the client which pane the frame belongs to; a single pane keeps the plain frame.
  const tabId = (rec.tabs?.split?.visible.length ?? 0) > 1 ? rec.tabs?.state.activeTabId ?? undefined : undefined
  cast.onFrame({ seq: cast.seq, jpeg, ...(lat ? { lat } : {}), ...(tabId ? { tabId } : {}) })
}

/** Frame of an on-screen tab that is not the view: same sequence as the view's frames (one ack space per node), tagged with its tab. */
export function pushSideFrame(rec: NodeRec, tabId: string, sessionId: string, p: Record<string, unknown>): void {
  const cast = rec.cast
  if (!cast || typeof p.data !== 'string' || typeof p.sessionId !== 'number') return
  cast.seq = (cast.seq + 1) >>> 0
  cast.acks.set(cast.seq, p.sessionId)
  ;(cast.sides ??= new Map()).set(cast.seq, sessionId)
  cast.onFrame({ seq: cast.seq, jpeg: Buffer.from(p.data, 'base64'), tabId })
}

/** Catat input bercap waktu; yang pertama dalam satu ledakan dipertahankan (Orca typing-latency: ledakan = satu sampel). */
export function notePendingInput(rec: NodeRec, ls: number, rx: number, dispatched: number): void {
  if (!rec.lat || rx - rec.lat.rx > INPUT_LATENCY_STALE_MS) rec.lat = { ls, rx, dispatched }
}

/**
 * Frame pertama yang `metadata.timestamp` (detik epoch, jam Chromium = jam mesin ini) jatuh SESUDAH dispatch
 * input tertunda -> rincian latensi, dan input dilepas. Frame lebih tua -> tetap menunggu.
 */
export function frameLatency(rec: NodeRec, metadata: unknown, now: number): FrameLatency | undefined {
  const pend = rec.lat
  const ts = (metadata as { timestamp?: unknown } | undefined)?.timestamp
  if (!pend || typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
  const swap = ts * 1000
  if (swap <= pend.dispatched) return undefined
  rec.lat = undefined
  if (swap - pend.dispatched > INPUT_LATENCY_STALE_MS) return undefined // input tanpa perubahan layar; frame ini milik hal lain
  return { ls: pend.ls, rxToDispatch: pend.dispatched - pend.rx, dispatchToSwap: swap - pend.dispatched, swapToServer: Math.max(0, now - swap) }
}

/** State baru bila `part` mengubah sesuatu; null bila tidak ada perubahan. */
export function mergeState(cur: BrowserState, part: Partial<BrowserState>): BrowserState | null {
  const next = { ...cur, ...part }
  return (Object.keys(next) as Array<keyof BrowserState>).every((k) => next[k] === cur[k]) ? null : next
}

/** `net::ERR_ABORTED`: navigation cancelled (Stop, download, 204), never shown as a failure. */
export const isAbortedNav = (errorText: string): boolean => /ERR_ABORTED$/.test(errorText)

const NO_URL = /^(about|chrome-error):/i
/** Halaman internal Chromium: tidak dicek penjaga dan tidak menimpa URL terakhir yang baik. */
export const isInternalUrl = (u: string): boolean => NO_URL.test(u)

/** A popup waiting for its first url: its opener node and the opener's target (to find the opener tab). */
export interface PendingPopup { opener: NodeRec; openerId?: string }

/** Info target dari Chromium: kenali popup (`window.open`) milik node (dari tab depan maupun latar); `url` kosong = belum siap. */
export function popupOf(table: TargetTable, popups: Map<string, PendingPopup>, created: boolean, info: { targetId: string; type: string; url: string; openerId?: string }): { opener: NodeRec; openerId?: string; url: string } | null {
  if (info.type !== 'page' || table.target(info.targetId) || table.bgTarget(info.targetId)) return null
  const known = (created && (table.target(info.openerId) ?? table.bgTarget(info.openerId)?.rec)) || undefined
  const pending: PendingPopup | undefined = known ? { opener: known, openerId: info.openerId } : popups.get(info.targetId)
  if (!pending) return null
  if (!info.url || isInternalUrl(info.url)) { popups.set(info.targetId, pending); return null } // URL belum ada; tunggu info berikutnya
  popups.delete(info.targetId)
  return { ...pending, url: info.url }
}
