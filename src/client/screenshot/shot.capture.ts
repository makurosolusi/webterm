// Freezes the page into a full-resolution bitmap BEFORE the overlay mounts. Shares the engine of the
// agent path (canvasShot.ts: element cap, visibility filter, one capture at a time). The overlay root
// must carry `data-shot-ignore` (SHOT_IGNORE_ATTR) so it is never captured.
import { planCapture, runExclusiveCapture } from '../canvasShot'

/** Longest edge of the captured bitmap in pixels; keeps canvas memory safe on hi-dpi 4K+ screens. */
export const SHOT_MAX_SIDE_PX = 8192
/** Total pixel budget of the captured bitmap (about 128 MB of RGBA). */
export const SHOT_MAX_PIXELS = 32_000_000

export type CaptureFailure = 'busy' | 'page_too_large' | 'failed'
export type FrameResult =
  | { ok: true; frame: HTMLCanvasElement; cssWidth: number; cssHeight: number; scale: number }
  | { ok: false; reason: CaptureFailure }

/** Pixels per CSS pixel: the device ratio, lowered when the side or total-pixel budget would be exceeded. */
export function captureScale(cssWidth: number, cssHeight: number, dpr: number): number {
  const w = Math.max(1, cssWidth), h = Math.max(1, cssHeight)
  const want = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return Math.min(want, SHOT_MAX_SIDE_PX / Math.max(w, h), Math.sqrt(SHOT_MAX_PIXELS / (w * h)))
}

/** Capture the visible page as a lossless canvas at (budget-capped) native resolution. Never rejects. */
export async function captureFrame(): Promise<FrameResult> {
  const plan = planCapture()
  if (!plan) return { ok: false, reason: 'page_too_large' }
  const scale = captureScale(plan.width, plan.height, window.devicePixelRatio)
  try {
    const run = await runExclusiveCapture(async () => {
      // Loaded on first use: most sessions never annotate.
      const { domToCanvas } = await import('modern-screenshot')
      return domToCanvas(plan.root, {
        ...plan.common, scale,
        // The canvas keeps alpha; fill with the page color so exports are never see-through.
        backgroundColor: getComputedStyle(plan.root).backgroundColor || '#000',
      })
    })
    if (run.busy) return { ok: false, reason: 'busy' }
    return { ok: true, frame: run.value, cssWidth: plan.width, cssHeight: plan.height, scale }
  } catch (err) {
    console.warn('[webterm] screenshot annotate: capture failed', err)
    return { ok: false, reason: 'failed' }
  }
}
