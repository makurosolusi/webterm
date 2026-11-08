// Penempatan node baru di canvas (murni: tanpa DOM/RF). Satu algoritme untuk client (buka browser/file)
// dan server (canvasPush); konstanta di sini adalah satu-satunya sumber.
export type XY = { x: number; y: number }
export type Size = { width: number; height: number }
export type Rect = Size & XY // koordinat FLOW

export const OPEN_GAP = 32 // jarak antar node yang ditempatkan berdampingan
export const ANCHOR_FALLBACK_SIZE: Size = { width: 420, height: 300 } // node belum terukur
export const SCAN_COLS = 8
export const SCAN_ROWS = 8
export const CASCADE_STEP = 36 // sama dengan OFFSET_STEP di nodeSpawn.ts
const CASCADE_CYCLE = 6

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Rect yang dijamin terhingga: angka NaN/Infinity diganti 0 (posisi) atau ukuran fallback. */
function clean(r: Rect | undefined): Rect | undefined {
  if (!r) return undefined
  return {
    x: num(r.x, 0),
    y: num(r.y, 0),
    width: num(r.width, ANCHOR_FALLBACK_SIZE.width),
    height: num(r.height, ANCHOR_FALLBACK_SIZE.height),
  }
}

/** Beririsan setelah `occ` diperlebar GAP/2 tiap sisi (tepi bersentuhan tidak dihitung). */
function hits(x: number, y: number, size: Size, occ: Rect[]): boolean {
  const pad = OPEN_GAP / 2
  return occ.some(
    (o) =>
      x < o.x + o.width + pad && x + size.width > o.x - pad && y < o.y + o.height + pad && y + size.height > o.y - pad,
  )
}

/** Sudut kiri-atas untuk node baru: `at` apa adanya, lalu kanan/bawah/kiri anchor, pindai grid, kaskade. Hasil selalu terhingga. */
export function placeBeside(a: {
  anchor?: Rect
  at?: XY
  center: XY
  occupied: Rect[]
  size: Size
}): XY {
  const { size } = a
  if (a.at && Number.isFinite(a.at.x) && Number.isFinite(a.at.y)) return { x: a.at.x, y: a.at.y }
  const anchor = clean(a.anchor)
  const occ = a.occupied.map((r) => clean(r) as Rect)
  const cx = num(a.center?.x, 0)
  const cy = num(a.center?.y, 0)
  if (anchor) {
    const sides: XY[] = [
      { x: anchor.x + anchor.width + OPEN_GAP, y: anchor.y }, // kanan
      { x: anchor.x, y: anchor.y + anchor.height + OPEN_GAP }, // bawah
      { x: anchor.x - size.width - OPEN_GAP, y: anchor.y }, // kiri
    ]
    const free = sides.find((p) => !hits(p.x, p.y, size, occ))
    if (free) return free
  }
  const x0 = anchor ? anchor.x : cx - size.width / 2
  const y0 = anchor ? anchor.y : cy - size.height / 2
  for (let r = 0; r < SCAN_ROWS; r++) {
    for (let c = 0; c < SCAN_COLS; c++) {
      const x = x0 + c * (size.width + OPEN_GAP)
      const y = y0 + r * (size.height + OPEN_GAP)
      if (!hits(x, y, size, occ)) return { x, y }
    }
  }
  const k = (occ.length % CASCADE_CYCLE) * CASCADE_STEP // grid habis: tumpuk bertingkat, tak pernah menolak
  return { x: x0 + k, y: y0 + k }
}
