// Tabel target per node + operasi target tingkat rendah (buat/attach/riwayat/setup koneksi).
// Tidak menyimpan kebijakan; `BrowserHost` yang memutuskan kapan memanggil.
import { INPUT_LATENCY_STALE_MS } from '../../shared/browser.contract'
import type { BlockReason, BrowserErrorCode, BrowserState, Frame, FrameLatency } from '../../shared/browser.contract'
import { hostOnly, parseBrowserUrl } from '../../shared/browser.url'
import type { DeviceSpec } from '../../shared/browser.devices'
import { DEFAULT_VIEWPORT, DENIED_PERMISSIONS, windowPlacement } from './chromium.flags'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { metricsParams } from './browserHost.input'

/** Galat host ber-kode; gateway memetakan `code` ke `{t:'error'}` (tanpa URL, hanya hostname). */
export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string, readonly hostname?: string, cause?: unknown) {
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
 * popup sah yang harus dibuka klien sebagai node browser baru di sebelah pembukanya.
 */
export type HostEvent =
  | { k: 'dialog'; nodeId: string; kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt?: string }
  | { k: 'error'; nodeId: string; code: BrowserErrorCode; hostname?: string }
  | { k: 'popup'; nodeId: string; url: string }

export { DEFAULT_VIEWPORT }

export interface NodeRec {
  nodeId: string
  workspaceId: string
  targetId?: string
  sessionId?: string
  state: BrowserState
  viewport: { w: number; h: number; dpr: number }
  /** `acks`: seq milik kita -> id ack screencast milik Chromium (dikirim hanya setelah `ackFrame`). */
  cast?: { onFrame: (f: Frame) => void; seq: number; acks: Map<number, number> }
  touch: boolean
  /** Device mode (browserHost.device.ts): spec = emulated device, null = Responsive, undefined = not seeded from the board yet. */
  device?: DeviceSpec | null
  /** Input bercap waktu PERTAMA yang belum terjawab frame (I1-d); `rx`/`dispatched` = jam server, ms epoch. */
  lat?: { ls: number; rx: number; dispatched: number }
}

export function newRec(nodeId: string, workspaceId: string, url: string): NodeRec {
  return {
    nodeId, workspaceId, touch: false, viewport: { ...DEFAULT_VIEWPORT },
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
}

/** Setup sekali per koneksi browser: temukan target (popup) dan tolak download + izin perangkat. */
export async function setupConnection(cdp: CdpClient): Promise<void> {
  await cdp.send(CDP.setDiscoverTargets, { discover: true })
  await cdp.send(CDP.setDownloadBehavior, { behavior: 'deny' })
  for (const name of DENIED_PERMISSIONS) {
    await cdp.send(CDP.setPermission, { permission: { name }, setting: 'denied' })
  }
}

/** Buat jendela kosong di latar (windowPlacement), attach (flatten), aktifkan Page, pasang viewport awal. */
export async function createPageTarget(cdp: CdpClient, vp: NodeRec['viewport']): Promise<{ targetId: string; sessionId: string }> {
  const { targetId } = await cdp.send<{ targetId: string }>(CDP.createTarget, { url: 'about:blank', ...windowPlacement() })
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
  cast.onFrame(lat ? { seq: cast.seq, jpeg, lat } : { seq: cast.seq, jpeg })
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

/** Info target dari Chromium: kenali popup (`window.open`) milik node; `url` kosong = belum siap. */
export function popupOf(table: TargetTable, popups: Map<string, NodeRec>, created: boolean, info: { targetId: string; type: string; url: string; openerId?: string }): { opener: NodeRec; url: string } | null {
  if (info.type !== 'page' || table.target(info.targetId)) return null
  const opener = (created && table.target(info.openerId)) || popups.get(info.targetId)
  if (!opener) return null
  if (!info.url || isInternalUrl(info.url)) { popups.set(info.targetId, opener); return null } // URL belum ada; tunggu info berikutnya
  popups.delete(info.targetId)
  return { opener, url: info.url }
}
