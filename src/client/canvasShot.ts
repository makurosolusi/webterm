// `t:'shot'` from the central agent (`canvas.screenshot`): the visible window captures what the user
// sees and uploads it to `POST /api/canvas-shot/<reqId>`. Hidden tabs stay silent, so the server
// answers `no_visible_window` on its own timeout instead of getting a picture nobody is looking at.
//
// Terminal pixels: xterm's WebGL canvas is created with `preserveDrawingBuffer` (TerminalCore.tsx),
// otherwise `toDataURL` on it reads back blank. Browser nodes paint into a 2D canvas, which reads back as-is.
import { useEffect } from 'react'
import type { ShotMsg } from '../shared/protocol'
import { subscribeShot } from './ws'

export const SHOT_QUALITY = 0.8
/** modern-screenshot's font/image load timeout; must stay below the server's SHOT_TIMEOUT_MS (shotBroker.ts). */
export const CAPTURE_TIMEOUT_MS = 10_000
/** The server's upload cap (`POST /api/canvas-shot`). */
export const SHOT_MAX_BYTES = 4 * 1024 * 1024

export const shotUrl = (reqId: string): string => `/api/canvas-shot/${encodeURIComponent(reqId)}`

/** The whole page, not one board: body also holds sidebar, tabs and portaled dialogs/notices. */
async function capture(maxWidth: number): Promise<Blob> {
  const root = document.body
  const width = root.getBoundingClientRect().width || window.innerWidth
  const scale = Math.min(1, maxWidth / Math.max(1, width))
  // Loaded on the first shot only: most sessions never take one.
  const { domToBlob } = await import('modern-screenshot')
  const blob = await domToBlob(root, {
    type: 'image/jpeg', quality: SHOT_QUALITY, scale, timeout: CAPTURE_TIMEOUT_MS,
    // JPEG has no alpha: a transparent page would come out black.
    backgroundColor: getComputedStyle(root).backgroundColor || '#000',
  })
  if (blob.size > SHOT_MAX_BYTES) throw new Error(`screenshot is ${blob.size} bytes, over the ${SHOT_MAX_BYTES} byte cap`)
  return blob
}

/** Answer one shot request. Never rejects: capture and upload failures are logged with the request id. */
export async function answerShot(msg: ShotMsg): Promise<void> {
  if (document.visibilityState !== 'visible') return
  let init: RequestInit
  try {
    const blob = await capture(msg.maxWidth)
    // The browser falls back to PNG when it cannot encode JPEG; the blob's own type says which.
    init = { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob }
  } catch (err) {
    console.warn(`[webterm] canvas screenshot ${msg.reqId}: capture failed`, err)
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'capture_failed' }) }
  }
  try {
    const res = await fetch(shotUrl(msg.reqId), init)
    // 404/409: another tab answered first, or the request expired. Nothing to do.
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      console.warn(`[webterm] canvas screenshot ${msg.reqId}: upload answered ${res.status}`)
    }
  } catch (err) {
    console.warn(`[webterm] canvas screenshot ${msg.reqId}: upload failed`, err)
  }
}

/** Answer shot requests for as long as the caller is mounted. */
export function useCanvasShot(): void {
  useEffect(() => subscribeShot((msg) => { void answerShot(msg) }), [])
}
