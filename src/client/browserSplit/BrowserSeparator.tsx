// Draggable, keyboard-operable separator between two panes (WAI-ARIA window splitter): arrows nudge, Shift+arrows move far,
// Home/End jump to the smallest/largest allowed ratio, double-click or Enter resets to 50/50. Panes never get smaller than
// MIN_PANE_PX, so the ratio is clamped by the branch's real size, not just the 10% floor.
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { MIN_PANE_PX, MIN_RATIO } from '../../shared/browser.layout'
import { boxRect, ratioFromPointer } from '../paneTree'
import type { DividerRect } from '../paneTree'

const SMALL_STEP = 0.02
const LARGE_STEP = 0.1
/** Half the separator's thickness (`.bp-sep` in browserSplit.css), so it sits exactly on the border. */
const HALF = 4

export interface BrowserSeparatorProps {
  divider: DividerRect
  /** Branch ratio now (0..1). */
  ratio: number
  /** The element the percentages refer to (the pane stage). */
  host: () => HTMLElement | null
  onRatio: (path: string, ratio: number) => void
  onCommit: () => void
  onReset: (path: string) => void
}

const pct = (n: number): string => `${n}%`
export function separatorStyle(d: DividerRect): CSSProperties {
  return d.dir === 'h'
    ? { left: `calc(${pct(d.at)} - ${HALF}px)`, top: pct(d.box.top), height: pct(d.box.height) }
    : { top: `calc(${pct(d.at)} - ${HALF}px)`, left: pct(d.box.left), width: pct(d.box.width) }
}

/** Smallest and largest ratio that keep both sides at least MIN_PANE_PX (never crossing each other on a tiny branch). */
export function ratioBounds(spanPx: number): { min: number; max: number } {
  if (spanPx <= 0) return { min: MIN_RATIO, max: 1 - MIN_RATIO }
  const floor = Math.max(MIN_RATIO, MIN_PANE_PX / spanPx)
  return floor >= 0.5 ? { min: 0.5, max: 0.5 } : { min: floor, max: 1 - floor }
}

export function BrowserSeparator({ divider: d, ratio, host, onRatio, onCommit, onReset }: BrowserSeparatorProps) {
  const spanPx = (): number => {
    const el = host()
    return el ? (d.dir === 'h' ? el.clientWidth * d.box.width : el.clientHeight * d.box.height) / 100 : 0
  }
  const set = (r: number) => { const b = ratioBounds(spanPx()); onRatio(d.path, Math.min(b.max, Math.max(b.min, r))) }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation() // not a canvas pan or node drag
    const el = e.currentTarget
    const hostEl = host()
    if (!hostEl) return
    el.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => set(ratioFromPointer(boxRect(hostEl.getBoundingClientRect(), d.box), { x: ev.clientX, y: ev.clientY }, d.dir))
    const up = () => {
      el.releasePointerCapture?.(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onCommit()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = d.dir === 'h' ? 'ArrowRight' : 'ArrowDown'
    const shrink = d.dir === 'h' ? 'ArrowLeft' : 'ArrowUp'
    const step = e.shiftKey ? LARGE_STEP : SMALL_STEP
    const b = ratioBounds(spanPx())
    const to = e.key === grow ? ratio + step : e.key === shrink ? ratio - step : e.key === 'Home' ? b.min : e.key === 'End' ? b.max : null
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onReset(d.path); return }
    if (to === null) return
    e.preventDefault()
    e.stopPropagation()
    set(to)
    onCommit()
  }

  return (
    <div
      role="separator"
      aria-orientation={d.dir === 'h' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round((1 - MIN_RATIO) * 100)}
      aria-label={d.dir === 'h' ? 'Resize panes side by side' : 'Resize panes top and bottom'}
      tabIndex={0}
      className={`bp-sep bp-sep--${d.dir} nodrag nowheel nopan nokey`}
      style={separatorStyle(d)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onReset(d.path)}
    />
  )
}
