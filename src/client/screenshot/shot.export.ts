// Export of the annotated crop: PNG blob, clipboard, download. Nothing here touches the network:
// the image never leaves the browser (no upload/share/search, deliberately unlike LightShot).
import { renderScene, type ShotFrame } from './shot.render'
import type { CopyResult, Rect, Shape } from './shot.types'

/** Delay before the download object URL is revoked, so the browser has started the save. */
export const REVOKE_DELAY_MS = 1000

/** Render the crop with all shapes at full resolution into a new canvas. */
export function cropAndRender(frame: ShotFrame, selection: Rect, shapes: readonly Shape[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(selection.w))
  canvas.height = Math.max(1, Math.round(selection.h))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('screenshot export: 2D canvas context unavailable')
  renderScene(ctx, frame, shapes, { selection })
  return canvas
}

/** Lossless PNG of the annotated crop. */
export function exportPng(frame: ShotFrame, selection: Rect, shapes: readonly Shape[]): Promise<Blob> {
  const canvas = cropAndRender(frame, selection, shapes)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('screenshot export: PNG encoding failed'))), 'image/png')
  })
}

/** Put the PNG on the clipboard; the result says why not when it fails (no silent fallback). */
export async function copyImage(blob: Blob): Promise<CopyResult> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') return 'unsupported'
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return 'ok'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return 'denied'
    console.warn('[webterm] screenshot copy failed', err)
    return 'failed'
  }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `webterm-YYYYMMDD-HHmmss.png` in local time. */
export function shotFileName(d: Date = new Date()): string {
  return `webterm-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.png`
}

/** Download through an object URL on an `<a download>` (never a new tab); the URL is revoked afterwards. */
export function saveImage(blob: Blob, name: string = shotFileName()): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
