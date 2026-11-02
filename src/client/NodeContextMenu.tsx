import type { ReactNode } from 'react'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'

export interface MenuItem {
  label: string
  icon?: ReactNode
  /** Tooltip. Untuk baris disabled, inilah yang memberitahu pengguna apa yang harus ditunggu. */
  hint?: string
  disabled?: boolean
  /** Baris destruktif (membuang riwayat, menghapus node) — ditandai `data-danger` (VS Code tidak mewarnai merah). */
  danger?: boolean
  onClick: () => void
}

export type MenuRow = MenuItem | { type: 'separator' }

const isSeparator = (r: MenuRow): r is { type: 'separator' } => 'type' in r

function toItems(rows: MenuRow[]): VscodeMenuItem[] {
  return rows.map((row, index) =>
    isSeparator(row)
      ? { type: 'separator' }
      : {
          type: 'item',
          id: `${row.label}-${index}`,
          label: row.label,
          icon: row.icon,
          disabled: row.disabled,
          danger: row.danger,
          title: row.hint,
          onSelect: row.onClick,
        },
  )
}

/**
 * Context menu sebuah node di atas primitif `VscodeMenu` (portal ke `document.body`, 22px rows,
 * roving focus, type-ahead, submenu flip, Escape per level).
 *
 * Portal itu bukan detail: pembungkus node di canvas React Flow punya `transform` CSS, yang menjadi
 * containing block untuk anak `position: fixed` — di dalamnya menu akan bergeser dan ikut ter-zoom
 * bersama canvas.
 */
export default function NodeContextMenu({
  x,
  y,
  rows,
  onClose,
}: {
  x: number
  y: number
  rows: MenuRow[]
  onClose: () => void
}) {
  return (
    <VscodeMenu
      open
      anchor={{ x, y }}
      items={toItems(rows)}
      onClose={onClose}
      ariaLabel="Node actions"
    />
  )
}
