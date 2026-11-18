// Mengikat satu node browser ke klien WS bersama: attach/resize/detach (ResizeObserver, debounce),
// menggambar frame lalu `ack`, dan menampung state/galat/dialog/kursor dari server.
// Hanya frame TERBARU yang digambar (decode bisa selesai tak berurutan), dan setelah resize frame transisi
// berukuran lama dibuang sampai frame yang cocok tiba (Orca browser-screencast-stream.ts:114-127).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { DSF_MAX, RESIZE_DEBOUNCE_MS } from '../shared/browser.contract'
import type { BrowserState, ClientMsg, FrameLatency, ServerMsg } from '../shared/browser.contract'
import { clientNow, createLatencyWindow, recordFrame, wantsStamp } from './browser/latency/inputLatency.window'
import type { LatencyWindow } from './browser/latency/inputLatency.window'
import { writeClipboard } from './browser.clipboard'
import type { Viewport } from './browser.input'
import { STICKY_ERRORS } from './browser.status'
import type { BrowserErr } from './browser.status'
import { browserStream } from './browser.stream'
import { passesResizeFilter, RESIZE_FILTER_MAX_MS } from './browser.stream.fit'
import type { ResizeFilter } from './browser.stream.fit'
import type { BrowserStream } from './browser.stream'
import { applyConsoleDelta, EMPTY_CONSOLE } from '../shared/browser.console'
import type { ConsoleView } from '../shared/browser.console'
import { isTabMsg, type TabMsg } from './browserTabs/useBrowserTabs'
import { SYNC_OFF, applySyncMsg, isSyncMsg } from './browserSplit/browserSync'
import type { SyncView } from './browserSplit/browserSync'
import { applyDownloadMsg, isDownloadMsg } from './browserDownloads/browserDownloads.state'
import type { DownloadItem } from '../shared/browser.downloads'

export type BrowserDialog = Extract<ServerMsg, { t: 'dialog' }>
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
const NOTICE_MS = 4000 // galat non-sticky / catatan lokal hilang sendiri
const CURSOR_SAFE = /^[a-z-]{1,32}$/ // hanya kata kunci; `url(...)` dari server tak boleh memicu fetch

export interface BrowserSession {
  hostRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Ukuran viewport (CSS px) yang terakhir dikirim ke server; dasar `toPagePoint`. */
  viewport: RefObject<Viewport | null>
  state?: BrowserState
  error?: BrowserErr
  /** Catatan lokal (decode frame / clipboard gagal). */
  localNotice: string
  dialog?: BrowserDialog
  cursor: string
  connected: boolean
  send: (msg: WithoutId<ClientMsg>) => void
  /** Ask the server to open this node again (after a refused attach or a failed launch); false = not attached yet (no size to send). */
  retry: () => boolean
  closeDialog: () => void
  /** Latensi input->frame node ini (I1-d), dibaca chip. */
  latency: LatencyWindow
  /** Page console of this node (deltas from the server buffer). */
  console: ConsoleView
  /** Split view: where frames of a pane's tab are drawn (returns the unsubscribe). Frames of a tab without a pane are dropped. */
  panes: PaneFrames
  /** Sync mode of the node (server session state) and the panes whose last mirrored action found no match. */
  sync: SyncView
  /** Downloads of this node (server list on attach, then one message per change); see browserDownloads/. */
  downloads: DownloadItem[]
}

/** Draws a decoded frame; the session closes the bitmap afterwards. */
export type PaneSink = (bmp: ImageBitmap) => void
export interface PaneFrames { register(tabId: string, sink: PaneSink): () => void }

/**
 * `paused` = lepas dari server (zoom kecil / collapse); kanvas tetap menampilkan frame terakhir.
 * `onTabMsg` = pesan tab dari server (`tabs`/`tab`/`tabNotice`); popup kini menjadi tab di server, bukan pesan `popup`.
 */
export function useBrowserSession(id: string, paused: boolean, stream: BrowserStream = browserStream, onTabMsg?: (m: TabMsg) => void, profileId?: string): BrowserSession {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<Viewport | null>(null)
  const attached = useRef(false)
  /** Aktif sesudah resize terkirim: buang frame berukuran salah; `held` = frame terbuang terbaru (digambar bila waktu habis). */
  const filter = useRef<(ResizeFilter & { held?: { bmp: ImageBitmap; order: number } }) | null>(null)
  /** Nomor urut kedatangan frame (bukan `seq` server, yang mulai dari 1 lagi tiap screencast dimulai ulang). */
  const order = useRef({ arrived: 0, painted: 0 })
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [state, setState] = useState<BrowserState>()
  const [error, setError] = useState<BrowserErr>()
  const [localNotice, setLocalNotice] = useState('')
  const [dialog, setDialog] = useState<BrowserDialog>()
  const [cursor, setCursor] = useState('default')
  const [connected, setConnected] = useState(true)
  const [latency] = useState(createLatencyWindow)
  const [consoleView, setConsoleView] = useState<ConsoleView>(EMPTY_CONSOLE)
  const [sync, setSync] = useState<SyncView>(SYNC_OFF)
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const paneSinks = useRef(new Map<string, PaneSink>())
  const panes = useMemo<PaneFrames>(() => ({
    register(tabId, sink) {
      paneSinks.current.set(tabId, sink)
      return () => { if (paneSinks.current.get(tabId) === sink) paneSinks.current.delete(tabId) }
    },
  }), [])
  const tabMsgRef = useRef(onTabMsg)
  tabMsgRef.current = onTabMsg
  const profileRef = useRef(profileId)
  profileRef.current = profileId

  const arm = useCallback((clear: () => void) => {
    const t = setTimeout(() => { timers.current.delete(t); clear() }, NOTICE_MS)
    timers.current.add(t)
  }, [])
  const flash = useCallback((text: string) => { setLocalNotice(text); arm(() => setLocalNotice('')) }, [arm])

  /** Gambar bila lebih baru dari yang sudah tergambar (decode bisa selesai tak berurutan); bitmap selalu ditutup. */
  const draw = useCallback((bmp: ImageBitmap, n: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (n > order.current.painted && canvas && ctx) {
      order.current.painted = n
      // Ukuran backing store = piksel frame (viewport x dpr): tanpa resample, tanpa blur.
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
      ctx.drawImage(bmp, 0, 0)
    }
    bmp.close()
  }, [])
  /** Matikan filter resize; frame tertahan (bila ada) digambar. */
  const endFilter = useCallback(() => {
    const held = filter.current?.held
    filter.current = null
    if (held) draw(held.bmp, held.order)
  }, [draw])

  useEffect(() => {
    // A frame tagged with a tab belongs to a split pane: draw it there (no resize filter: each pane has its own size) or drop a stale one.
    const paintPane = async (seq: number, jpeg: Uint8Array, tabId: string) => {
      const sink = paneSinks.current.get(tabId)
      if (sink) {
        try {
          const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
          sink(bmp)
          bmp.close()
        } catch (err) {
          flash(`Frame decode failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (attached.current) stream.send({ t: 'ack', id, seq })
    }
    const paint = async (seq: number, jpeg: Uint8Array, lat?: FrameLatency) => {
      const rxAt = lat ? clientNow() : 0
      const n = ++order.current.arrived
      try {
        const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
        const f = filter.current
        if (n <= order.current.painted) bmp.close() // lebih tua dari frame yang sudah tergambar
        else if (f && !passesResizeFilter(f, bmp)) {
          // Frame transisi resize (ukuran lama): tahan yang terbaru saja, untuk batas waktu filter.
          if (!f.held || n > f.held.order) { f.held?.bmp.close(); f.held = { bmp, order: n } } else bmp.close()
        } else {
          if (f) { f.held?.bmp.close(); filter.current = null } // cocok, atau batas jumlah buang tercapai
          draw(bmp, n)
        }
      } catch (err) {
        flash(`Frame decode failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (lat) recordFrame(latency, lat, rxAt, clientNow()) // sesudah draw (atau dibuang karena frame lebih baru sudah tergambar)
      // Ack SETELAH gambar (juga bila decode/dibuang): hanya mengatur laju kirim server ke klien ini
      // (MAX_FRAMES_IN_FLIGHT); Chromium sudah di-ack server saat frame diterima.
      if (attached.current) stream.send({ t: 'ack', id, seq })
    }
    const unsub = stream.subscribe(id, {
      onFrame: (seq, jpeg, lat, tabId) => { void (tabId ? paintPane(seq, jpeg, tabId) : paint(seq, jpeg, lat)) },
      onConnection: setConnected,
      onMsg: (m) => {
        if (m.t === 'state') { setState(m); setError(undefined) }
        else if (m.t === 'error') {
          setError({ code: m.code, hostname: m.hostname, reason: m.reason })
          if (!STICKY_ERRORS.has(m.code)) arm(() => setError(undefined))
        } else if (m.t === 'dialog') setDialog(m)
        else if (isTabMsg(m)) tabMsgRef.current?.(m)
        else if (isSyncMsg(m)) setSync((v) => applySyncMsg(v, m, Date.now()))
        else if (isDownloadMsg(m)) setDownloads((v) => applyDownloadMsg(v, m))
        else if (m.t === 'console') setConsoleView((v) => applyConsoleDelta(v, m))
        else if (m.t === 'cursor') setCursor(CURSOR_SAFE.test(m.css) ? m.css : 'default')
        else if (m.t === 'copy') {
          void writeClipboard(m.text).then((r) => { if (!r.ok) flash(r.error) })
        }
      },
    })
    return () => {
      unsub()
      for (const t of timers.current) clearTimeout(t)
      timers.current.clear()
    }
  }, [id, stream, arm, flash, draw, endFilter, latency])

  useEffect(() => {
    const host = hostRef.current
    if (paused || !host || typeof ResizeObserver === 'undefined') return
    let debounce: ReturnType<typeof setTimeout> | null = null
    let expire: ReturnType<typeof setTimeout> | null = null
    const vpMsg = (v: Viewport) => ({ ...v, dpr: Math.min(window.devicePixelRatio || 1, DSF_MAX) })
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      const w = Math.round(box?.width ?? 0), h = Math.round(box?.height ?? 0)
      if (w < 1 || h < 1) return // node tersembunyi/collapse: ukuran nol tidak valid di kawat
      const first = !attached.current
      viewport.current = { w, h }
      if (first) {
        attached.current = true
        stream.attach(id, vpMsg({ w, h }), profileRef.current)
        return
      }
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        const vp = vpMsg({ w, h })
        filter.current?.held?.bmp.close()
        filter.current = { vp, drops: 0 }
        if (expire) clearTimeout(expire)
        expire = setTimeout(endFilter, RESIZE_FILTER_MAX_MS) // batas waktu: node tak boleh membeku
        stream.resize(id, vp)
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      if (debounce) clearTimeout(debounce)
      if (expire) clearTimeout(expire)
      attached.current = false
      stream.detach(id)
    }
  }, [id, paused, stream, endFilter])

  const send = useCallback((msg: WithoutId<ClientMsg>) => {
    const m = { ...msg, id } as ClientMsg
    if (wantsStamp(m)) (m as { ls?: number }).ls = clientNow() // dipantulkan server di frame pertama sesudahnya
    stream.send(m)
  }, [id, stream])
  const retry = useCallback(() => {
    const vp = viewport.current
    if (!vp || !attached.current) return false
    stream.attach(id, { ...vp, dpr: Math.min(window.devicePixelRatio || 1, DSF_MAX) }, profileRef.current)
    return true
  }, [id, stream])
  return {
    hostRef, canvasRef, viewport, state, error, localNotice, dialog, cursor, connected, send, retry, latency, console: consoleView, panes, sync, downloads,
    closeDialog: useCallback(() => setDialog(undefined), []),
  }
}
