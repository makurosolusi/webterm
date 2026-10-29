// Lapisan daun menu konteks canvas: satu baris, dan flyout submenu-nya. Dipisah dari
// `CanvasContextMenu.tsx` supaya panel (penempatan, keyboard, portal) dan baris (ikon, state aria,
// pemilihan sisi flyout) tidak tumbuh di satu file yang sama — keduanya berubah karena alasan yang
// berbeda. Keputusan geometrinya tetap bukan milik file ini: ia memanggil fungsi murni di
// `canvasMenu.geometry.ts` dan hanya menyediakan angka hasil pengukuran DOM.
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, FolderTree, Scan, Sparkles, SquareDashed, SquareTerminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CanvasMenuIcon, CanvasMenuItem } from './canvasMenu.model'
import { SUBMENU_TOP_PX, submenuLift, submenuSide } from './canvasMenu.geometry'
import type { SubmenuSide } from './canvasMenu.geometry'

export const ICON_PX = 14

const ICONS: Record<CanvasMenuIcon, LucideIcon> = {
  terminal: SquareTerminal,
  agent: Sparkles,
  files: FolderTree,
  'select-all': SquareDashed,
  fit: Scan,
}

/**
 * Satu baris. Baris nonaktif memakai `aria-disabled`, BUKAN atribut `disabled` native: `disabled`
 * mencabut baris dari pembacaan screen reader dan dari `title`-nya, sehingga pengguna tidak pernah
 * tahu kenapa baris itu mati. Jadi ia tetap bisa disinggahi dan dibaca, tapi aktivasinya ditolak
 * di satu tempat (`pick` di panel) — diredupkan saja tidak cukup.
 */
export function CanvasMenuRowButton({
  item,
  id,
  active,
  onPick,
  onHover,
}: {
  item: CanvasMenuItem
  id: string
  active: boolean
  onPick: (item: CanvasMenuItem) => void
  onHover: () => void
}) {
  const Icon = ICONS[item.icon]
  const hasSub = !!item.children?.length
  return (
    <button
      id={id}
      type="button"
      role="menuitem"
      // `tabIndex -1`: fokus tinggal di panel dan baris aktif diumumkan lewat
      // `aria-activedescendant`, jadi Tab tidak berjalan melewati tiap baris satu per satu.
      tabIndex={-1}
      className="node-menu__item"
      aria-disabled={item.disabled || undefined}
      aria-current={active || undefined}
      aria-haspopup={hasSub ? 'menu' : undefined}
      aria-expanded={hasSub ? active : undefined}
      title={item.hint}
      onMouseEnter={onHover}
      onClick={() => onPick(item)}
    >
      <span className="node-menu__icon">
        {item.dot ? (
          <span className="node-menu__dot" style={{ background: item.dot }} />
        ) : (
          <Icon size={ICON_PX} aria-hidden />
        )}
      </span>
      <span>{item.label}</span>
      {hasSub && <ChevronRight className="node-menu__caret" size={ICON_PX} aria-hidden />}
    </button>
  )
}

/**
 * Flyout submenu. Komponennya sendiri karena pengukurannya adalah state per-flyout (sisi mana, dan
 * seberapa jauh diangkat), dan hanya flyout yang sedang terbuka yang boleh punya keputusan itu.
 *
 * Diukur setelah render tapi SEBELUM paint (`useLayoutEffect`), jadi flyout tidak pernah terlihat
 * di sisi yang salah lalu melompat. Rect yang dibaca adalah OFFSET PARENT — barisnya — sebab rect
 * flyout sendiri sudah mengandung sisi yang justru sedang dihitung.
 */
export function CanvasSubmenu({
  items,
  activeIndex,
  labelledBy,
  itemId,
  onPick,
  onHover,
}: {
  items: CanvasMenuItem[]
  activeIndex: number
  labelledBy: string
  itemId: (i: number) => string
  onPick: (item: CanvasMenuItem) => void
  onHover: (i: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [side, setSide] = useState<SubmenuSide>('right')
  const [lift, setLift] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    const row = el?.offsetParent as HTMLElement | null
    if (!el || !row) return
    const measure = (): void => {
      const r = row.getBoundingClientRect()
      const nextSide = submenuSide({
        rowLeft: r.left,
        rowRight: r.right,
        width: el.offsetWidth,
        viewportWidth: window.innerWidth,
      })
      // Dijaga identitas: tick ResizeObserver tanpa perubahan nyata tidak boleh jadi loop render.
      setSide((cur) => (cur === nextSide ? cur : nextSide))
      const up = submenuLift({ rowTop: r.top, height: el.offsetHeight, viewportHeight: window.innerHeight })
      setLift((cur) => (cur === up ? cur : up))
    }
    measure()
    // Diukur ulang saat ukuran berubah, alasan yang sama: flyout yang tumbuh harus boleh berubah pikiran.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className="node-menu node-menu__sub"
      data-side={side}
      style={lift ? { top: SUBMENU_TOP_PX - lift } : undefined}
      role="menu"
      aria-labelledby={labelledBy}
    >
      {items.map((item, i) => (
        <CanvasMenuRowButton
          key={item.key}
          item={item}
          id={itemId(i)}
          active={i === activeIndex}
          onPick={onPick}
          onHover={() => onHover(i)}
        />
      ))}
    </div>
  )
}
