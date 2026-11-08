// Penempatan node browser baru di canvas (murni: tanpa DOM/RF). Algoritme penempatan hidup di
// `shared/canvasPlace.ts` (dipakai juga oleh server); di sini ukuran browser + konstanta fit-view.
import type { Rect, Size } from '../shared/canvasPlace'

export { ANCHOR_FALLBACK_SIZE, CASCADE_STEP, OPEN_GAP, SCAN_COLS, SCAN_ROWS, placeBeside, type Rect, type Size } from '../shared/canvasPlace'

// Tinggi = DEFAULT_H di BrowserNode.tsx; sengaja diduplikasi agar berkas ini tak bergantung pada komponen.
export const BROWSER_OPEN_SIZE: Size = { width: 640, height: 400 }
// Harus > ZOOM_PAUSE_BELOW (0.25) agar stream tidak dijeda sesudah fit-view; dijaga tes.
export const FIT_MIN_ZOOM = 0.3
export const FIT_MAX_ZOOM = 1
export const FIT_PADDING = 0.2
export const FIT_DURATION_MS = 250

/** Benar bila `r` (koordinat flow) sepenuhnya di dalam layar pada viewport tersebut. */
export function rectInView(r: Rect, viewport: { x: number; y: number; zoom: number }, screen: Size): boolean {
  const left = r.x * viewport.zoom + viewport.x
  const top = r.y * viewport.zoom + viewport.y
  return (
    left >= 0 &&
    top >= 0 &&
    left + r.width * viewport.zoom <= screen.width &&
    top + r.height * viewport.zoom <= screen.height
  )
}
