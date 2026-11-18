// The surface of ONE pane: its own canvas, its own size and an input channel tagged with the pane's tab. It borrows the
// node's connection (frames arrive through `session.panes`, messages leave through `session.send`) so a pane behaves like
// the single-pane surface without a second socket.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DSF_MAX, RESIZE_DEBOUNCE_MS } from '../../shared/browser.contract'
import type { BrowserSession } from '../browser.useSession'
import type { Viewport } from '../browser.input'

export interface PaneSession extends BrowserSession {
  /** Measured size of the pane body (CSS px); null before the first measure. */
  size: { w: number; h: number } | null
}

/** Frames of `tabId` are drawn on this pane's canvas; its measured size goes to the server for that tab. */
export function usePaneSession(session: BrowserSession, tabId: string, reportSize: boolean): PaneSession {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<Viewport | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const sendRef = useRef(session.send)
  sendRef.current = session.send

  useEffect(() => session.panes.register(tabId, (bmp) => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height } // frame pixels = canvas pixels: no resample
    ctx.drawImage(bmp, 0, 0)
  }), [session.panes, tabId])

  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      const w = Math.round(box?.width ?? 0), h = Math.round(box?.height ?? 0)
      if (w < 1 || h < 1) return
      viewport.current = { w, h }
      setSize({ w, h })
      if (!reportSize) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => sendRef.current({ t: 'resize', tab: tabId, w, h, dpr: Math.min(window.devicePixelRatio || 1, DSF_MAX) }), RESIZE_DEBOUNCE_MS)
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (timer) clearTimeout(timer) }
  }, [tabId, reportSize])

  const send = useCallback<BrowserSession['send']>((msg) => sendRef.current({ ...msg, tab: tabId } as Parameters<BrowserSession['send']>[0]), [tabId])
  return useMemo(() => ({ ...session, hostRef, canvasRef, viewport, send, size }), [session, send, size])
}
