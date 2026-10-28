// Matematika penempatan menu mengapung, murni dan tanpa DOM. Komponen yang MENGUKUR (offsetWidth,
// getBoundingClientRect) ada di `CanvasContextMenu.tsx`; yang MEMUTUSKAN ada di sini, supaya aturan
// pembalikan arah bisa diuji di environment node tanpa browser.
//
// Diporting dari nodeterm `src/renderer/ui/useMenuFlip.ts` dan `ui/useSubmenuFlip.ts`.
import type { XYPosition } from '@xyflow/react'

/** Jarak aman dari tepi viewport. Dipakai sumbu X maupun Y, root menu maupun flyout. */
export const MENU_VIEWPORT_MARGIN = 6

/**
 * Seberapa jauh flyout menindih barisnya sendiri, supaya kursor tidak pernah menyeberangi celah
 * kosong (celah sekecil apa pun akan menutup submenu di tengah gerakan diagonal). HARUS sama
 * dengan `calc(100% - 4px)` di `.node-menu__sub` pada `canvas-ui.css`.
 */
export const SUBMENU_OVERLAP_PX = 4

/** Offset istirahat flyout terhadap tepi atas barisnya. Cermin `--submenu-top` di canvas-ui.css. */
export const SUBMENU_TOP_PX = -6

/** Ke sisi mana flyout submenu membuka. */
export type SubmenuSide = 'right' | 'left'

/**
 * Titik klik kanan yang benar-benar bisa dipakai melahirkan node, atau `undefined` kalau tidak.
 *
 * BUKAN paranoia. Titik itu sampai ke App sebagai parameter OPSIONAL TERAKHIR `onAddTerminal` /
 * `onAddFiles` — dan kedua fungsi itu juga disambung langsung ke `onClick` sebuah tombol di tempat
 * lain (`CanvasToolbar`), tempat React menitipkan event-nya di parameter pertama yang tersedia.
 * SyntheticEvent tidak punya `.x`/`.y`, jadi tanpa gerbang ini sebuah klik tombol Explorer
 * melahirkan node di posisi NaN: tak terlihat di canvas, tapi tetap ikut tersimpan ke workspace.
 * TypeScript tidak menangkapnya — `(at?: T) => void` assignable ke `() => void`.
 */
export function spawnSpot(at?: XYPosition): XYPosition | undefined {
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : undefined
}

/**
 * Posisi akhir panel menu yang muncul di kursor.
 *
 * - Sumbu Y: kalau menu akan menembus tepi bawah, BAWAHNYA yang dijangkarkan ke titik klik — menu
 *   membuka ke atas, seperti menu native. Clamp ke margin adalah upaya terakhir untuk menu yang
 *   lebih tinggi daripada viewport-nya.
 * - Sumbu X: digeser masuk supaya tepi kanannya tetap di dalam viewport, bukan dibalik — menu yang
 *   melompat ke kiri kursor terasa seperti salah tempat, sedangkan bergeser masuk tidak.
 */
export function clampMenuPosition(input: {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
}): { x: number; y: number } {
  const m = input.margin ?? MENU_VIEWPORT_MARGIN
  const y =
    input.y + input.height > input.viewportHeight - m
      ? Math.max(m, input.y - input.height)
      : input.y
  const x = Math.max(m, Math.min(input.x, input.viewportWidth - input.width - m))
  return { x, y }
}

/**
 * Sisi tempat flyout submenu membuka, dari posisi barisnya dan lebar flyout terukur.
 *
 * Flyout TIDAK bisa memakai clamp `clampMenuPosition`: ia diposisikan terhadap BARISNYA, bukan
 * terhadap viewport, jadi jawabannya adalah sebuah sisi, bukan sebuah offset. Tanpa ini sebuah
 * menu yang dibuka dekat tepi kanan jendela akan mendorong flyout-nya keluar layar sepenuhnya.
 *
 * Saat tidak ada sisi yang muat (jendela sempit, flyout lebar), sisi yang lebih longgar yang
 * menang alih-alih menolak membuka — `max-width` flyout sendiri yang membatasi, jadi sebagiannya
 * tetap terjangkau.
 */
export function submenuSide(input: {
  /** Tepi kiri/kanan baris submenu dalam koordinat viewport. */
  rowLeft: number
  rowRight: number
  /** Lebar flyout terukur. */
  width: number
  viewportWidth: number
  margin?: number
}): SubmenuSide {
  const m = input.margin ?? MENU_VIEWPORT_MARGIN
  const rightEdge = input.rowRight - SUBMENU_OVERLAP_PX + input.width
  if (rightEdge <= input.viewportWidth - m) return 'right'
  const leftEdge = input.rowLeft + SUBMENU_OVERLAP_PX - input.width
  if (leftEdge >= m) return 'left'
  const roomRight = input.viewportWidth - m - (input.rowRight - SUBMENU_OVERLAP_PX)
  const roomLeft = input.rowLeft + SUBMENU_OVERLAP_PX - m
  return roomLeft > roomRight ? 'left' : 'right'
}

/**
 * Seberapa jauh flyout harus diangkat supaya bawahnya tetap di dalam viewport. Pembalikan sisi
 * hanya membereskan sumbu horizontal; flyout yang dibuka dari baris dekat tepi bawah masih bisa
 * keluar layar. Tidak pernah mengangkat melewati margin atas: flyout yang lebih tinggi daripada
 * viewport dibatasi `max-height`-nya sendiri dan menggulir.
 */
export function submenuLift(input: {
  /** Tepi atas baris submenu dalam koordinat viewport. */
  rowTop: number
  /** Tinggi flyout terukur. */
  height: number
  viewportHeight: number
  margin?: number
}): number {
  const m = input.margin ?? MENU_VIEWPORT_MARGIN
  const top = input.rowTop + SUBMENU_TOP_PX
  const overflow = top + input.height - (input.viewportHeight - m)
  if (overflow <= 0) return 0
  return Math.max(0, Math.min(overflow, top - m))
}
