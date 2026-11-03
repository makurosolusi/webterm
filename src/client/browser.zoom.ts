// Zoom halaman node browser. Murni klien: protokol server tidak punya pesan zoom, jadi node
// mengecilkan/membesarkan viewport yang dilaporkan (lihat `.browser-zoom` di BrowserNode).

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1
export const ZOOM_DEFAULT = 1

/** Zoom berikutnya (arah -1/+1), dibulatkan 2 desimal agar tak melayang dan dijepit ke batas. */
export function stepZoom(zoom: number, dir: -1 | 1): number {
  const next = Math.round((zoom + dir * ZOOM_STEP) * 100) / 100
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}

/** Label persen untuk toolbar, mis. 1.1 -> "110%". */
export const zoomLabel = (zoom: number): string => `${Math.round(zoom * 100)}%`
