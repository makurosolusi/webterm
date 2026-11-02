// Penjaga titik spawn node dari menu konteks canvas, murni dan tanpa DOM. Penempatan panel menu
// (flip/geser di viewport, submenu) kini dimiliki `components/vscode/vscodeMenu.tsx`.
import type { XYPosition } from '@xyflow/react'

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
