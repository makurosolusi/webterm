// Mengikat satu node browser ke klien WS bersama: attach/resize/detach (ResizeObserver, debounce),
// menggambar frame lalu `ack`, dan menampung state/galat/dialog/kursor dari server.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { DSF_MAX, RESIZE_DEBOUNCE_MS } from '../shared/browser.contract'
import type { BrowserState, ClientMsg, ServerMsg } from '../shared/browser.contract'
import { writeClipboard } from './browser.clipboard'
import type { Viewport } from './browser.input'
import { STICKY_ERRORS } from './browser.status'
import type { BrowserErr } from './browser.status'
import { browserStream } from './browser.stream'
import type { BrowserStream } from './browser.stream'

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
  closeDialog: () => void
}

/** `paused` = lepas dari server (zoom kecil / collapse); kanvas tetap menampilkan frame terakhir. */
export function useBrowserSession(id: string, paused: boolean, stream: BrowserStream = browserStream): BrowserSession {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<Viewport | null>(null)
  const attached = useRef(false)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [state, setState] = useState<BrowserState>()
  const [error, setError] = useState<BrowserErr>()
  const [localNotice, setLocalNotice] = useState('')
  const [dialog, setDialog] = useState<BrowserDialog>()
  const [cursor, setCursor] = useState('default')
  const [connected, setConnected] = useState(true)

  const arm = useCallback((clear: () => void) => {
    const t = setTimeout(() => { timers.current.delete(t); clear() }, NOTICE_MS)
    timers.current.add(t)
  }, [])
  const flash = useCallback((text: string) => { setLocalNotice(text); arm(() => setLocalNotice('')) }, [arm])

  useEffect(() => {
    const paint = async (seq: number, jpeg: Uint8Array) => {
      try {
        const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx) {
          // Ukuran backing store = piksel frame (viewport x dpr): tanpa resample, tanpa blur.
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
          ctx.drawImage(bmp, 0, 0)
        }
        bmp.close()
      } catch (err) {
        flash(`Frame decode failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Ack SETELAH gambar (juga bila decode gagal, supaya stream tak macet di MAX_FRAMES_IN_FLIGHT).
      if (attached.current) stream.send({ t: 'ack', id, seq })
    }
    const unsub = stream.subscribe(id, {
      onFrame: (seq, jpeg) => { void paint(seq, jpeg) },
      onConnection: setConnected,
      onMsg: (m) => {
        if (m.t === 'state') { setState(m); setError(undefined) }
        else if (m.t === 'error') {
          setError({ code: m.code, hostname: m.hostname })
          if (!STICKY_ERRORS.has(m.code)) arm(() => setError(undefined))
        } else if (m.t === 'dialog') setDialog(m)
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
  }, [id, stream, arm, flash])

  useEffect(() => {
    const host = hostRef.current
    if (paused || !host || typeof ResizeObserver === 'undefined') return
    let debounce: ReturnType<typeof setTimeout> | null = null
    const vpMsg = (v: Viewport) => ({ ...v, dpr: Math.min(window.devicePixelRatio || 1, DSF_MAX) })
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      const w = Math.round(box?.width ?? 0), h = Math.round(box?.height ?? 0)
      if (w < 1 || h < 1) return // node tersembunyi/collapse: ukuran nol tidak valid di kawat
      const first = !attached.current
      viewport.current = { w, h }
      if (first) { attached.current = true; stream.attach(id, vpMsg({ w, h })); return }
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => stream.resize(id, vpMsg({ w, h })), RESIZE_DEBOUNCE_MS)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      if (debounce) clearTimeout(debounce)
      attached.current = false
      stream.detach(id)
    }
  }, [id, paused, stream])

  const send = useCallback((msg: WithoutId<ClientMsg>) => stream.send({ ...msg, id } as ClientMsg), [id, stream])
  return {
    hostRef, canvasRef, viewport, state, error, localNotice, dialog, cursor, connected, send,
    closeDialog: useCallback(() => setDialog(undefined), []),
  }
}
