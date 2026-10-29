// Di mana node baru lahir. Dulu `80 + n * 40`: tangga diagonal dari titik asal yang buta pan/zoom,
// jadi node ke-13 mendarat di (560,560) — bisa di luar layar, dan pengguna harus mencarinya.
import type { XYPosition } from '@xyflow/react'

type Size = { width: number; height: number }

const OFFSET_STEP = 36
const OFFSET_CYCLE = 6

/**
 * Titik kiri-atas node baru. Dikurangi separuh ukuran karena x/y sebuah node adalah SUDUT-nya:
 * tanpa itu node melenceng ke kanan-bawah sejauh separuh dirinya.
 *
 * Offset kecilnya BERPUTAR (bukan `n * 40` lagi) supaya dua `+` berturut-turut tidak menumpuk
 * persis, tapi n besar tetap dekat tengah pandangan alih-alih berjalan keluar layar.
 */
export function spawnPosition(center: XYPosition, size: Size, n: number): XYPosition {
  const off = (n % OFFSET_CYCLE) * OFFSET_STEP
  return { x: center.x - size.width / 2 + off, y: center.y - size.height / 2 + off }
}

/**
 * Tengah pandangan pengguna, dihitung React Flow sendiri — canvas webterm fullscreen, jadi tengah
 * layar = tengah canvas. Dipisah dari `spawnPosition` karena bagian ini butuh DOM.
 */
export function spawnAt(
  rf: { screenToFlowPosition: (p: XYPosition) => XYPosition } | null,
  settings: { defaultNodeWidth: number; defaultNodeHeight: number },
  n: number,
): XYPosition {
  const size: Size = { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight }
  const center = rf?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  // Tanpa instance (belum `onInit`) jatuh ke sudut lama (80,80) — bukan ke NaN.
  return spawnPosition(center ?? { x: 80 + size.width / 2, y: 80 + size.height / 2 }, size, n)
}
