import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Separator } from '@/components/ui/separator'
import './agent.css'

export interface MenuItem {
  label: string
  icon?: ReactNode
  /** Tooltip. Untuk baris disabled, inilah yang memberitahu pengguna apa yang harus ditunggu. */
  hint?: string
  disabled?: boolean
  /** Baris destruktif (membuang riwayat, menghapus node) — diwarnai berbeda. */
  danger?: boolean
  onClick: () => void
}

export type MenuRow = MenuItem | { type: 'separator' }

const isSeparator = (r: MenuRow): r is { type: 'separator' } => 'type' in r

/**
 * Context menu sebuah node. Di-portal ke `document.body`: pembungkusnya di canvas React Flow punya
 * `transform` CSS, yang menjadi containing block untuk anak `position: fixed` — di dalamnya menu
 * akan bergeser dan ikut ter-zoom bersama canvas.
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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Pointerdown DI DALAM panel dibiarkan: ia menutup panel sebelum `click` terbentuk (click
    // menuntut pointerdown & pointerup di elemen yang sama), jadi barisnya lenyap dan `onClick`
    // tidak pernah terpanggil — seluruh menu tampak muncul lalu diam.
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // `capture`: terminal xterm di bawahnya menghentikan propagasi pointer-nya sendiri.
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="node-menu nodrag nopan"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {rows.map((row, i) =>
        isSeparator(row) ? (
          <Separator key={`sep-${i}`} className="node-menu__sep" />
        ) : (
          <button
            key={row.label}
            type="button"
            role="menuitem"
            className={`node-menu__item${row.danger ? ' node-menu__item--danger' : ''}`}
            disabled={row.disabled}
            title={row.hint}
            onClick={() => {
              onClose()
              row.onClick()
            }}
          >
            {row.icon && <span className="node-menu__icon">{row.icon}</span>}
            <span>{row.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
