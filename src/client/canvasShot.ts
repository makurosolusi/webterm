// `t:'shot'` from the central agent (`canvas.screenshot`): the visible window captures what the user
// sees and uploads it to `POST /api/canvas-shot/<reqId>`. Hidden tabs stay silent, so the server
// answers `no_visible_window` on its own timeout instead of getting a picture nobody is looking at.
//
// Terminal pixels: xterm's WebGL canvas is created with `preserveDrawingBuffer` (TerminalCore.tsx),
// otherwise `toDataURL` on it reads back blank. Browser nodes paint into a 2D canvas, which reads back as-is.
import { useEffect } from 'react'
import type { ShotMsg } from '../shared/protocol'
import { countShotElements, MAX_SHOT_ELEMENTS, shotFilter } from './canvasShot.scope'
import { subscribeShot } from './ws'

export const SHOT_QUALITY = 0.8
/** modern-screenshot's font/image load timeout; must stay below the server's SHOT_TIMEOUT_MS (shotBroker.ts). */
export const CAPTURE_TIMEOUT_MS = 10_000
/** The server's upload cap (`POST /api/canvas-shot`). */
export const SHOT_MAX_BYTES = 4 * 1024 * 1024

export const shotUrl = (reqId: string): string => `/api/canvas-shot/${encodeURIComponent(reqId)}`

const jsonError = (code: string): RequestInit =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: code }) })

/** Elements carrying this attribute (and their subtrees) are never captured; the screenshot overlay sets it on its root. */
export const SHOT_IGNORE_ATTR = 'data-shot-ignore'

export interface CapturePlan {
  root: HTMLElement
  width: number
  height: number
  filter: (node: Node) => boolean
  /** modern-screenshot options shared by the agent path and the annotate path. */
  common: { width: number; height: number; filter: (node: Node) => boolean; timeout: number; features: { copyScrollbar: false } }
}

/** The whole page clipped to the viewport: body also holds sidebar, tabs and portaled dialogs/notices.
 *  Only on-screen elements are cloned (canvasShot.scope.ts); a page over MAX_SHOT_ELEMENTS gives null. */
export function planCapture(): CapturePlan | null {
  const root = document.body
  const width = window.innerWidth
  const height = window.innerHeight
  const visible = shotFilter({ width, height })
  const filter = (node: Node): boolean =>
    !(node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute(SHOT_IGNORE_ATTR)) && visible(node)
  if (countShotElements(root, filter, MAX_SHOT_ELEMENTS) > MAX_SHOT_ELEMENTS) return null
  return {
    root, width, height, filter,
    // body is 100% of the viewport (styles.css), so width/height clip without resizing anything.
    // Seven extra getComputedStyle calls per scrollable element, for scrollbar styling nobody needs.
    common: { width, height, filter, timeout: CAPTURE_TIMEOUT_MS, features: { copyScrollbar: false } },
  }
}

/** One capture at a time: a second full clone on top of the first is what freezes the tab. */
let capturing = false

/** Run `job` unless another capture is running; `busy` means it was not started. */
export async function runExclusiveCapture<T>(job: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  if (capturing) return { busy: true }
  capturing = true
  try {
    return { busy: false, value: await job() }
  } finally {
    capturing = false
  }
}

async function capture(maxWidth: number): Promise<RequestInit> {
  const plan = planCapture()
  if (!plan) return jsonError('page_too_large')
  const { root, width, common } = plan
  const scale = Math.min(1, maxWidth / Math.max(1, width))
  // Loaded on the first shot only: most sessions never take one.
  const { domToBlob } = await import('modern-screenshot')
  const blob = await domToBlob(root, {
    ...common, type: 'image/jpeg', quality: SHOT_QUALITY, scale,
    // JPEG has no alpha: a transparent page would come out black.
    backgroundColor: getComputedStyle(root).backgroundColor || '#000',
  })
  if (blob.size > SHOT_MAX_BYTES) throw new Error(`screenshot is ${blob.size} bytes, over the ${SHOT_MAX_BYTES} byte cap`)
  // The browser falls back to PNG when it cannot encode JPEG; the blob's own type says which.
  return { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob }
}

/** Answer one shot request. Never rejects: capture and upload failures are logged with the request id. */
export async function answerShot(msg: ShotMsg): Promise<void> {
  if (document.visibilityState !== 'visible') return
  let init: RequestInit
  try {
    const r = await runExclusiveCapture(() => capture(msg.maxWidth))
    init = r.busy ? jsonError('capture_busy') : r.value
  } catch (err) {
    console.warn(`[webterm] canvas screenshot ${msg.reqId}: capture failed`, err)
    init = jsonError('capture_failed')
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
