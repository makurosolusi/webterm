// Render sebuah pohon pane: tiap daun satu `TerminalCore`, tiap cabang satu pembatas yang bisa
// digeser.
//
// RATA, bukan bersarang: posisi tiap pane dihitung `paneLayout` (persen) dan dipasang sebagai
// elemen absolut ber-key id pane. Alasannya ada di doc `paneLayout` — elemen bersarang membuat
// setiap split memindahkan daun satu tingkat lebih dalam, dan React membuang terminal yang
// berpindah posisi di pohon. Di sini split hanya mengubah `style`.
//
// Refit TIDAK dikerjakan di sini: setiap `TerminalCore` sudah punya `ResizeObserver(refit)`
// sendiri, jadi pane yang berubah ukuran memberi tahu terminalnya tanpa satu baris tambahan.
//
// NAMANYA bukan `PaneTree`: file itu hanya berbeda HURUF BESAR dari model `paneTree.ts`, dan di
// filesystem case-insensitive (default macOS) `import './PaneTree'` ikut cocok dengan `paneTree.ts`
// — resolver mengambil modul model yang tidak punya default export, lalu React melempar "Element
// type is invalid" saat render. Dua modul yang hanya dibedakan kapitalisasi tidak boleh berdampingan.
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import { boxRect, paneLayout, ratioFromPointer } from './paneTree'
import type { DividerRect, PaneRect, PanePath } from './paneTree'
import type { Pane } from '../shared/workspace'

/** Setengah ketebalan pembatas (`.pane-divider` di `node-chrome.css`), supaya ia duduk TEPAT di
 *  atas batas, bukan menjorok ke salah satu sisi. */
const HALF_DIVIDER = 3

export interface PaneViewProps {
  pane: Pane
  cwd?: string
  /** Pane yang jadi sasaran aksi header (split, search, clear). */
  activeId: string
  onActivate: (paneId: string) => void
  /** Daftar handle terminal dipegang PEMILIK (`TerminalNode`), bukan di sini: search/clear/refit
   *  harus mengenai pane yang aktif, dan hanya pemilik yang tahu mana itu. */
  onHandle: (paneId: string, h: TerminalHandle | null) => void
  onRatio: (path: PanePath, ratio: number) => void
}

const pct = (n: number): string => `${n}%`

function paneStyle(p: PaneRect): CSSProperties {
  return { left: pct(p.left), top: pct(p.top), width: pct(p.width), height: pct(p.height) }
}

/** Pembatas direntangkan sepanjang cabangnya dan DIGESER setengah ketebalannya ke belakang batas.
 *  Ketebalannya sendiri dari CSS, jadi hanya ada satu angka 6px di seluruh fitur ini. */
function dividerStyle(d: DividerRect): CSSProperties {
  return d.dir === 'h'
    ? { left: `calc(${pct(d.at)} - ${HALF_DIVIDER}px)`, top: pct(d.box.top), height: pct(d.box.height) }
    : { top: `calc(${pct(d.at)} - ${HALF_DIVIDER}px)`, left: pct(d.box.left), width: pct(d.box.width) }
}

export default function PaneView({ pane, cwd, activeId, onActivate, onHandle, onRatio }: PaneViewProps) {
  const { panes, dividers } = paneLayout(pane)

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>, d: DividerRect) => {
    // `nodrag` sudah menahan drag node React Flow (ia mencocokkan lewat `closest()`), tapi
    // propagasinya tetap dihentikan: tanpa itu pointerdown ini juga memilih/menggeser canvas.
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const host = el.parentElement
    if (!host) return
    // Pointer capture supaya gerakan yang keluar dari pembatas 6px (itu SELALU terjadi) tetap
    // mendarat di sini, bukan di terminal yang dilewatinya.
    el.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => {
      // Rect CABANG, dihitung dari rect host: pembatas duduk di host, jadi mengukur `el` sendiri
      // (atau host apa adanya) akan memakai rentang yang salah untuk split di dalam split.
      const branch = boxRect(host.getBoundingClientRect(), d.box)
      onRatio(d.path, ratioFromPointer(branch, { x: ev.clientX, y: ev.clientY }, d.dir))
    }
    const up = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div className="pane-host">
      {panes.map((p) => (
        <div
          // Key = id pane: itu yang membuat terminal sebuah pane bertahan melewati split dan
          // penutupan pane lain. Key berbasis posisi akan membuangnya persis seperti nesting.
          key={p.id}
          className={`pane${p.id === activeId ? ' pane--active' : ''}`}
          data-pane-id={p.id}
          style={paneStyle(p)}
          // CAPTURE: xterm menghentikan propagasi pointer-nya sendiri, jadi handler fase-bubble di
          // sini tidak akan pernah melihat klik yang mendarat di dalam terminal.
          onPointerDownCapture={() => onActivate(p.id)}
        >
          <TerminalCore ref={(h) => onHandle(p.id, h)} id={p.id} cwd={cwd} />
        </div>
      ))}
      {dividers.map((d) => (
        <div
          key={`${d.dir}:${d.path}`}
          className="pane-divider nodrag nopan"
          role="separator"
          aria-orientation={d.dir === 'h' ? 'vertical' : 'horizontal'}
          data-pane-path={d.path}
          style={dividerStyle(d)}
          onPointerDown={(e) => onDividerDown(e, d)}
        />
      ))}
    </div>
  )
}
