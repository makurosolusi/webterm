// Export of the comparison as it looks right now: one PNG composed from the same pixels the overlay shows.
import type { CompareMode } from './compare.state'
import type { Pixels } from './diff'

export interface ExportView { mode: CompareMode; swipe: number; onion: number; a: Pixels; b: Pixels; diff?: Pixels }
export type MakeCanvas = (w: number, h: number) => HTMLCanvasElement
export type ExportOutcome = { ok: true } | { ok: false; message: string }

const defaultMake: MakeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })

function layer(p: Pixels, make: MakeCanvas): HTMLCanvasElement {
  const c = make(p.width, p.height), ctx = c.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available for the export')
  const img = ctx.createImageData(p.width, p.height)
  img.data.set(p.data)
  ctx.putImageData(img, 0, 0)
  return c
}

/** The current view drawn on one canvas (swipe split, onion blend or the difference map over a dimmed base). */
export function renderComposite(v: ExportView, make: MakeCanvas = defaultMake): HTMLCanvasElement {
  const { width: w, height: h } = v.a
  const out = make(w, h), ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available for the export')
  ctx.drawImage(layer(v.a, make), 0, 0)
  if (v.mode === 'swipe') {
    ctx.save()
    ctx.beginPath(); ctx.rect(Math.round((w * v.swipe) / 100), 0, w, h); ctx.clip()
    ctx.drawImage(layer(v.b, make), 0, 0)
    ctx.restore()
  } else if (v.mode === 'onion') {
    ctx.globalAlpha = v.onion / 100
    ctx.drawImage(layer(v.b, make), 0, 0)
  } else if (v.diff) {
    ctx.globalAlpha = 0.65; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h) // dim the base so the red stands out
    ctx.globalAlpha = 1
    ctx.drawImage(layer(v.diff, make), 0, 0)
  }
  return out
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** `webterm-compare-20261118-191530.png` (local time). */
export const exportName = (d: Date): string =>
  `webterm-compare-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`

const toBlob = (c: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be encoded'))), 'image/png'))

/** Downloads the composed PNG; the object URL is revoked right after the click. */
export async function savePng(v: ExportView, now: Date, make?: MakeCanvas): Promise<ExportOutcome> {
  try {
    const blob = await toBlob(renderComposite(v, make))
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: exportName(now) })
    a.click()
    URL.revokeObjectURL(url)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `Could not save the comparison: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export const canCopyImage = (): boolean => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

/** Copies the composed PNG to the clipboard; permission and support problems come back as plain messages. */
export async function copyPng(v: ExportView, make?: MakeCanvas): Promise<ExportOutcome> {
  if (!canCopyImage()) return { ok: false, message: 'Copying images is not supported in this browser. Use Save as PNG.' }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(renderComposite(v, make)) })])
    return { ok: true }
  } catch (e) {
    const denied = e instanceof Error && e.name === 'NotAllowedError'
    return { ok: false, message: denied ? 'The browser blocked clipboard access. Allow it, or use Save as PNG.' : `Could not copy the comparison: ${e instanceof Error ? e.message : String(e)}` }
  }
}
