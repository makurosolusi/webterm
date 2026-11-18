// Captures what a pane shows right now. The lightest source is the pane's own <canvas>: the streamed frames are already
// painted there (frame pixels = canvas pixels), so a capture costs one getImageData and no server round trip.
import type { Pixels } from './diff'

export type CaptureFailure = 'missing' | 'no-frame' | 'error'
export class CaptureError extends Error {
  constructor(readonly kind: CaptureFailure, readonly tabId: string, message: string) { super(message); this.name = 'CaptureError' }
}
export interface Capture { tabId: string; pixels: Pixels; at: Date }
export interface PaneInfo { tabId: string; label: string }

const paneEl = (root: ParentNode, tabId: string): Element | undefined =>
  Array.from(root.querySelectorAll('[data-pane-tab]')).find((el) => el.getAttribute('data-pane-tab') === tabId)

/** Panes on screen in `root`, labelled with the title their group exposes ("Pane: <title>"). */
export function listPanes(root: ParentNode): PaneInfo[] {
  return Array.from(root.querySelectorAll('[data-pane-tab]')).map((el) => {
    const tabId = el.getAttribute('data-pane-tab') ?? ''
    return { tabId, label: (el.getAttribute('aria-label') ?? '').replace(/^Pane:\s*/, '') || tabId }
  })
}

/** Reads the current frame of `tabId`'s pane. Throws CaptureError('missing') when the pane is gone, ('no-frame') when nothing was painted. */
export function captureTab(root: ParentNode, tabId: string, now: () => Date = () => new Date()): Capture {
  const canvas = paneEl(root, tabId)?.querySelector('canvas')
  if (!canvas) throw new CaptureError('missing', tabId, `Pane for tab ${tabId} is not on screen`)
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width < 1 || canvas.height < 1) throw new CaptureError('no-frame', tabId, `Pane for tab ${tabId} has no readable frame`)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  if (!img.data.some((v, i) => i % 4 === 3 && v > 0)) throw new CaptureError('no-frame', tabId, `Pane for tab ${tabId} has not painted a frame yet`)
  return { tabId, pixels: img, at: now() }
}
