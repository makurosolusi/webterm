// Klien CDP mentah di atas `ws` (tanpa puppeteer/playwright). Satu socket = satu koneksi browser;
// target dialamatkan lewat `sessionId` (flatten). Semua method/event CDP yang dipakai host ada di tabel ini.
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { createLogger } from '../logs'

const log = createLogger('browser.cdp')

export const CDP_TIMEOUT_MS = 15_000
export const CDP_CONNECT_TIMEOUT_MS = 10_000

/** Tabel tunggal method CDP yang dipakai host (diuji: tak ada literal method di luar tabel ini). */
export const CDP = {
  createTarget: 'Target.createTarget', attachToTarget: 'Target.attachToTarget', closeTarget: 'Target.closeTarget',
  setDiscoverTargets: 'Target.setDiscoverTargets',
  pageEnable: 'Page.enable', navigate: 'Page.navigate', reload: 'Page.reload', stopLoading: 'Page.stopLoading',
  getNavigationHistory: 'Page.getNavigationHistory', navigateToHistoryEntry: 'Page.navigateToHistoryEntry',
  startScreencast: 'Page.startScreencast', stopScreencast: 'Page.stopScreencast',
  screencastFrameAck: 'Page.screencastFrameAck', handleDialog: 'Page.handleJavaScriptDialog',
  setFocusEmulation: 'Emulation.setFocusEmulationEnabled',
  setDeviceMetrics: 'Emulation.setDeviceMetricsOverride', setVisibleSize: 'Emulation.setVisibleSize', setTouchEmulation: 'Emulation.setTouchEmulationEnabled',
  setUserAgent: 'Emulation.setUserAgentOverride', setEmitTouch: 'Emulation.setEmitTouchEventsForMouse',
  mouse: 'Input.dispatchMouseEvent', key: 'Input.dispatchKeyEvent', insertText: 'Input.insertText',
  ime: 'Input.imeSetComposition', touch: 'Input.dispatchTouchEvent',
  getVersion: 'Browser.getVersion', setDownloadBehavior: 'Browser.setDownloadBehavior', setPermission: 'Browser.setPermission',
  evaluate: 'Runtime.evaluate', runIfWaiting: 'Runtime.runIfWaitingForDebugger',
  // Shields: intersep request (tahap Request) di halaman + iframe OOPIF yang di-auto-attach.
  setAutoAttach: 'Target.setAutoAttach', fetchEnable: 'Fetch.enable', continueRequest: 'Fetch.continueRequest',
  failRequest: 'Fetch.failRequest', fulfillRequest: 'Fetch.fulfillRequest',
  runtimeEnable: 'Runtime.enable', logEnable: 'Log.enable', releaseObjectGroup: 'Runtime.releaseObjectGroup', // console panel
} as const

/** Tabel tunggal event CDP yang didengar host. */
export const CDP_EVENT = {
  targetCreated: 'Target.targetCreated', targetInfoChanged: 'Target.targetInfoChanged',
  targetDestroyed: 'Target.targetDestroyed', targetCrashed: 'Target.targetCrashed',
  inspectorCrashed: 'Inspector.targetCrashed', screencastFrame: 'Page.screencastFrame',
  frameNavigated: 'Page.frameNavigated', navigatedWithinDocument: 'Page.navigatedWithinDocument',
  frameStartedLoading: 'Page.frameStartedLoading', frameStoppedLoading: 'Page.frameStoppedLoading',
  dialogOpening: 'Page.javascriptDialogOpening',
  requestPaused: 'Fetch.requestPaused', attachedToTarget: 'Target.attachedToTarget', detachedFromTarget: 'Target.detachedFromTarget',
  consoleApiCalled: 'Runtime.consoleAPICalled', exceptionThrown: 'Runtime.exceptionThrown', logEntryAdded: 'Log.entryAdded', // console panel
} as const

/** Versi produk browser (mis. "Chrome/131.0.6778.85") dari `Browser.getVersion`; userAgent penuh sengaja dibuang. */
export async function readBrowserProduct(cdp: CdpClient): Promise<string> {
  const r = await cdp.send<{ product?: unknown }>(CDP.getVersion)
  if (typeof r.product !== 'string' || !r.product) throw new Error(`cdp ${CDP.getVersion} returned no product string`)
  return r.product
}

/** A command cut short because the connection died (`close()` or the socket went away), not because CDP refused it. */
export class CdpClosedError extends Error {}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * `.catch` for every fire-and-forget CDP send: a connection that closed under the command is expected
 * (node closed mid-stream) and dropped; any other failure is logged with the method, ids and cause.
 */
export function ignoreClosed(method: string, ids?: Record<string, string | undefined>): (err: unknown) => void {
  return (err) => {
    if (err instanceof CdpClosedError) return
    const cause = err instanceof Error && err.cause !== undefined ? errText(err.cause) : undefined
    log.warn('cdp.fire', 'fire-and-forget cdp command failed', { ids, method, error: errText(err), cause })
  }
}

export type CdpHandler = (params: Record<string, unknown>, sessionId: string | undefined, method: string) => void
interface Pending { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Set<CdpHandler>>()
  private readonly closeHandlers = new Set<(err: Error) => void>()
  private dead: Error | null = null

  constructor(private readonly ws: WebSocket, private readonly timeoutMs = CDP_TIMEOUT_MS) {
    ws.on('message', (d) => this.onMessage(d))
    ws.on('close', (code) => this.fail(new Error(`cdp socket closed (code ${code})`)))
    ws.on('error', (err) => this.fail(new Error(`cdp socket error: ${err.message}`, { cause: err })))
  }

  /** Buka koneksi ke URL debugger browser; reject bila gagal/timeout. */
  static connect(url: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false })
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`cdp connect timed out after ${CDP_CONNECT_TIMEOUT_MS} ms`)) }, CDP_CONNECT_TIMEOUT_MS)
      ws.once('open', () => { clearTimeout(timer); resolve(new CdpClient(ws, timeoutMs)) })
      ws.once('error', (err) => { clearTimeout(timer); reject(new Error(`cdp connect failed: ${err.message}`, { cause: err })) })
    })
  }

  /** Kirim perintah CDP; hasil = `result`. Reject ber-konteks (method + id) saat error/timeout/putus. */
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T> {
    const id = this.nextId++
    if (this.dead) return Promise.reject(new CdpClosedError(`cdp ${method} (#${id}) not sent: ${this.dead.message}`))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp ${method} (#${id}) timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
      const frame = JSON.stringify({ id, method, params, sessionId })
      this.ws.send(frame, (err) => {
        if (err) this.settle(id, new Error(`cdp ${method} (#${id}) send failed: ${err.message}`, { cause: err }))
      })
    })
  }

  /** Dengarkan event ('*' = semua); mengembalikan fungsi berhenti-mendengar. */
  on(event: string, cb: CdpHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(cb)
    return () => { set.delete(cb) }
  }

  /** Dipanggil sekali saat koneksi mati (putus atau `close()`). */
  onClose(cb: (err: Error) => void): void {
    if (this.dead) cb(this.dead)
    else this.closeHandlers.add(cb)
  }

  get closed(): boolean { return this.dead !== null }

  close(): void {
    this.fail(new Error('cdp closed by client'))
  }

  private settle(id: number, err?: Error, result?: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(result)
  }

  private onMessage(data: RawData): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(data.toString())
    } catch (err) {
      this.fail(new Error('cdp received malformed message', { cause: err }))
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return // balasan terlambat setelah timeout
      if (msg.error) this.settle(msg.id, new Error(`cdp ${p.method} (#${msg.id}) failed: ${msg.error.message} (code ${msg.error.code})`))
      else this.settle(msg.id, undefined, msg.result ?? {})
      return
    }
    if (typeof msg.method !== 'string') return
    for (const key of [msg.method, '*']) {
      for (const cb of this.handlers.get(key) ?? []) {
        try {
          cb(msg.params ?? {}, msg.sessionId, msg.method)
        } catch (err) {
          log.error('cdp.handler', 'event handler threw', { method: msg.method, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
  }

  private fail(reason: Error): void {
    if (this.dead) return
    this.dead = reason
    for (const [id, p] of [...this.pending]) this.settle(id, new CdpClosedError(`cdp ${p.method} (#${id}) aborted: ${reason.message}`))
    const hs = [...this.closeHandlers]
    this.closeHandlers.clear()
    for (const cb of hs) cb(reason)
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate()
  }
}
