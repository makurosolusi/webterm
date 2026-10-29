// Panel menu konteks canvas: penempatan, navigasi keyboard, dan portal. Sengaja tipis — SEMUA
// keputusan ada di modul murni di sebelahnya (isi baris di `canvasMenu.model.ts`, matematika
// penempatan di `canvasMenu.geometry.ts`), dan barisnya sendiri di `CanvasMenuRow.tsx`. Alasannya
// ada di komentar kepala `canvasMenu.model.ts`: vitest repo ini belum punya DOM, jadi apa pun yang
// dilipat ke dalam komponen otomatis menjadi perilaku yang tidak teruji.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { isSeparator, nextItemIndex } from './canvasMenu.model'
import type { CanvasMenuItem, CanvasMenuRow } from './canvasMenu.model'
import { clampMenuPosition } from './canvasMenu.geometry'
import { CanvasMenuRowButton, CanvasSubmenu } from './CanvasMenuRow'
// Panel dasarnya memakai `.node-menu*` dari agent.css — menu node dan menu canvas adalah permukaan
// yang sama di mata pengguna, jadi mereka berbagi satu set token alih-alih dua panel yang mirip
// tapi tidak pernah persis sama. Tambahan khas canvas (submenu, caret, titik agent) di canvas-ui.css.
import './agent.css'
import './canvas-ui.css'

/**
 * Posisi panel setelah diukur: dihitung setelah render tapi SEBELUM paint (`useLayoutEffect`),
 * jadi menu tidak pernah terlihat di tempat salah lalu melompat. Diukur ulang saat ukurannya
 * berubah (`ResizeObserver`) karena tinggi panel ikut berubah saat submenu membuka.
 */
function useMenuPlacement(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const next = clampMenuPosition({
        x,
        y,
        width: el.offsetWidth,
        height: el.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
      // Dijaga identitas: tick ResizeObserver tanpa perubahan nyata tidak boleh jadi loop render.
      setPos((p) => (p.x === next.x && p.y === next.y ? p : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [x, y])
  return { ref, ...pos }
}

export interface CanvasContextMenuProps {
  /** Koordinat LAYAR tempat klik kanan terjadi. Konversi ke koordinat canvas sudah dilakukan
   *  pemanggil sebelum mengikatnya ke handler di `rows` — menu ini tidak tahu soal viewport flow. */
  x: number
  y: number
  rows: CanvasMenuRow[]
  onClose: () => void
}

/**
 * Di-portal ke `document.body`: pembungkusnya di canvas React Flow punya `transform` CSS, yang jadi
 * containing block untuk anak `position: fixed` — di dalamnya menu akan bergeser DAN ikut ter-zoom
 * bersama canvas. Sama alasannya dengan `NodeContextMenu`.
 */
export default function CanvasContextMenu({ x, y, rows, onClose }: CanvasContextMenuProps) {
  const place = useMenuPlacement(x, y)
  const baseId = useId()
  const [active, setActive] = useState(-1)
  /** Index baris root yang flyout-nya terbuka, dan baris aktif DI DALAM flyout (-1 = masih di root). */
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [subActive, setSubActive] = useState(-1)

  const rowId = (i: number): string => `${baseId}-r${i}`
  const subId = (i: number): string => `${baseId}-s${i}`

  useEffect(() => {
    // `capture`: terminal xterm di bawahnya menghentikan propagasi pointer-nya sendiri, jadi
    // listener fase bubble tidak akan pernah melihat klik yang jatuh di atas terminal.
    //
    // Pointerdown DI DALAM panel dibiarkan: ia menutup panel sebelum `click` terbentuk (click
    // menuntut pointerdown & pointerup di elemen yang sama), jadi barisnya lenyap dan aksinya
    // tidak pernah jalan. Ref root sudah mencakup flyout submenu — ia anak panel, bukan portal
    // tersendiri; itu yang dijaga test "baris di dalam flyout submenu tetap bisa dipilih".
    const close = (e: Event): void => {
      if (!place.ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [onClose, place.ref])

  // Fokus panelnya, bukan barisnya: seluruh navigasi digerakkan satu `onKeyDown` di sini, jadi
  // tidak ada fokus yang perlu dipindah-pindahkan antar elemen saat submenu membuka dan menutup.
  // Tanpa fokus awal ini panah dan Escape tidak akan pernah sampai ke panel.
  useEffect(() => void place.ref.current?.focus(), [place.ref])

  const closeSub = (): void => {
    setOpenSub(null)
    setSubActive(-1)
  }

  const pick = (item: CanvasMenuItem): void => {
    if (item.disabled) return
    if (item.children?.length) return // Baris submenu: klik hanya membukanya, hover/panah yang mengurus.
    onClose()
    item.onClick?.()
  }

  const subItems = openSub !== null ? ((rows[openSub] as CanvasMenuItem).children ?? []) : []

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Canvas mendengar keydown di document (Backspace menghapus node terpilih, panah mem-pan), jadi
    // event keyboard menu HARUS berhenti di sini — kalau tidak, menavigasi menu ikut menggeser canvas.
    e.stopPropagation()
    const inSub = openSub !== null && subActive >= 0

    if (e.key === 'Escape') {
      e.preventDefault()
      if (openSub !== null) closeSub()
      else onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      if (inSub) setSubActive(nextItemIndex(subItems, subActive, step))
      else {
        const next = nextItemIndex(rows, active, step)
        setActive(next)
        closeSub()
      }
      return
    }
    if (e.key === 'ArrowRight') {
      const row = active >= 0 ? rows[active] : undefined
      if (!inSub && row && !isSeparator(row) && row.children?.length) {
        e.preventDefault()
        setOpenSub(active)
        setSubActive(0)
      }
      return
    }
    if (e.key === 'ArrowLeft') {
      if (openSub !== null) {
        e.preventDefault()
        closeSub()
      }
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (inSub) pick(subItems[subActive])
      else {
        const row = active >= 0 ? rows[active] : undefined
        if (row && !isSeparator(row)) {
          if (row.children?.length) {
            setOpenSub(active)
            setSubActive(0)
          } else pick(row)
        }
      }
    }
  }

  const activeId = openSub !== null && subActive >= 0 ? subId(subActive) : active >= 0 ? rowId(active) : undefined

  return createPortal(
    <div
      ref={place.ref}
      className="node-menu node-menu--canvas nodrag nopan"
      style={{ left: place.x, top: place.y }}
      role="menu"
      aria-label="Canvas actions"
      aria-activedescendant={activeId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((row, i) =>
        isSeparator(row) ? (
          <div key={`sep-${i}`} className="node-menu__sep" />
        ) : (
          <div key={row.key} className="node-menu__row">
            <CanvasMenuRowButton
              item={row}
              id={rowId(i)}
              active={i === active}
              onPick={pick}
              onHover={() => {
                setActive(i)
                // Hover membuka flyout baris bersubmenu dan menutup yang lain — sebuah flyout yang
                // tetap terbuka saat kursor pindah ke baris lain menutupi baris di bawahnya.
                if (row.children?.length) {
                  setOpenSub(i)
                  setSubActive(-1)
                } else closeSub()
              }}
            />
            {openSub === i && row.children?.length ? (
              <CanvasSubmenu
                items={row.children}
                activeIndex={subActive}
                labelledBy={rowId(i)}
                itemId={subId}
                onPick={pick}
                onHover={setSubActive}
              />
            ) : null}
          </div>
        )
      )}
    </div>,
    document.body
  )
}
