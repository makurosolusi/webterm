// Menu konteks canvas di atas `VscodeMenu`: satu implementasi menu untuk seluruh aplikasi (portal ke
// body, baris 22px, roving focus, type-ahead, submenu, Escape per level). Isi baris adalah data murni
// di `canvasMenu.model.ts`; terjemahan ke item menu ada di `CanvasMenuRow.tsx`.
//
// Di-portal ke `document.body` oleh `VscodeMenu`: pembungkus canvas React Flow punya `transform` CSS
// yang membuat anak `position: fixed` bergeser dan ikut ter-zoom bersama canvas.
import { useMemo } from 'react'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import { toVscodeMenuItems } from './CanvasMenuRow'
import type { CanvasMenuRow } from './canvasMenu.model'

export interface CanvasContextMenuProps {
  /** Koordinat LAYAR tempat klik kanan terjadi. Konversi ke koordinat canvas sudah dilakukan
   *  pemanggil sebelum mengikatnya ke handler di `rows` — menu ini tidak tahu soal viewport flow. */
  x: number
  y: number
  rows: CanvasMenuRow[]
  onClose: () => void
}

/** Menu konteks pane canvas (klik kanan di area kosong). */
export default function CanvasContextMenu({ x, y, rows, onClose }: CanvasContextMenuProps) {
  const items = useMemo(() => toVscodeMenuItems(rows), [rows])
  return <VscodeMenu open anchor={{ x, y }} items={items} onClose={onClose} ariaLabel="Canvas actions" />
}
