// Selection frame: dashed border, eight handles and the size label. Purely visual (pointer-events none:
// the surface hit-tests), but focusable so the keyboard can move (arrows) and resize (Shift + arrows) it.
import type { KeyboardEvent } from 'react'
import { HANDLES, moveRect, resizeRect, sizeLabel } from '../shot.selection'
import type { Handle, Rect, Size } from '../shot.types'
import { labelFitsAbove, toCss } from './shot.ui.layout'
import { SHOT_TEXT } from './shot.ui.text'

/** Keyboard step in image pixels. */
export const NUDGE_PX = 10

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/** The selection after an arrow key: moved, or with Shift the bottom-right corner (top-left for the opposite sign) resized. Null for other keys. */
export function nudgeSelection(sel: Rect, key: string, shift: boolean, bounds: Size, step = NUDGE_PX): Rect | null {
  const d = ARROWS[key]
  if (!d) return null
  if (!shift) return moveRect(sel, d[0] * step, d[1] * step, bounds)
  const handle: Handle = `${d[1] ? (d[1] > 0 ? 's' : 'n') : ''}${d[0] ? (d[0] > 0 ? 'e' : 'w') : ''}` as Handle
  const from = { x: sel.x + (handle.includes('e') ? sel.w : 0), y: sel.y + (handle.includes('s') ? sel.h : 0) }
  return resizeRect(sel, handle, { x: from.x + d[0] * step, y: from.y + d[1] * step }, bounds)
}

export interface ShotSelectionProps {
  selection: Rect
  scale: number
  bounds: Size
  /** Handles and keyboard control only exist once the selection is committed. */
  interactive: boolean
  onChange: (r: Rect) => void
}

export function ShotSelection({ selection, scale, bounds, interactive, onChange }: ShotSelectionProps) {
  const box = toCss(selection, scale)
  const label = sizeLabel(selection)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const next = nudgeSelection(selection, e.key, e.shiftKey, bounds)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    onChange(next)
  }
  return (
    <div
      className="shot-selection"
      data-testid="shot-selection"
      role={interactive ? 'group' : undefined}
      aria-label={interactive ? SHOT_TEXT.selectionLabel(label) : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className={`shot-selection__label${labelFitsAbove(box) ? '' : ' shot-selection__label--inside'}`} aria-hidden>{label}</span>
      {interactive && HANDLES.map((h) => <span key={h} className={`shot-handle shot-handle--${h}`} aria-hidden />)}
    </div>
  )
}
