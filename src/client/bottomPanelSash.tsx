// Resize sash of a VS Code part: on the top edge of the bottom panel (`ns-resize`), the left
// edge of the secondary side bar, or the right edge of the left side bar (`ew-resize`). 4px hit area, pointer drag, keyboard resize
// (arrows 10px, Shift 50px, Home/End = min/max) and double-click back to the default size.
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'
import { bottomPanelHeight } from './bottomPanelHeight'
import type { PanelSize } from './panelSize'

/** Size after dragging an edge sash from `start` to `current` along its axis (towards the canvas = bigger).
 *  `trailing`: the sash is on the part's right/bottom edge, so the canvas lies the other way. */
export function heightAfterDrag(startSize: number, start: number, current: number, trailing = false): number {
  return startSize + (trailing ? current - start : start - current)
}

export interface PanelSashProps {
  size: PanelSize
  /** `horizontal` = a bar on the top edge (panel); `vertical` = a bar on the left edge (side bar). */
  orientation: 'horizontal' | 'vertical'
  label: string
  className: string
  /** Sash on the part's right edge (left side bar): dragging right grows it. */
  trailing?: boolean
}

/** Separator that resizes one part's shared size store. */
export function PanelSash({ size, orientation, label, className, trailing = false }: PanelSashProps): React.JSX.Element {
  size.use() // re-render on size change so aria-valuenow follows
  const drag = useRef<{ size: number; at: number } | null>(null)
  const axis = (event: ReactPointerEvent): number => (orientation === 'horizontal' ? event.clientY : event.clientX)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { size: size.current(), at: axis(event) }
    // Optional call: jsdom has no pointer capture; real browsers keep the drag on the sash.
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start) size.set(heightAfterDrag(start.size, start.at, axis(event), trailing))
  }
  const endDrag = (): void => { drag.current = null }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = size.afterKey(event.key, event.shiftKey, size.current())
    if (next === null) return
    event.preventDefault()
    size.set(next)
  }

  return (
    <div
      className={className}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={size.min}
      aria-valuemax={size.max()}
      aria-valuenow={size.current()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={size.reset}
      onKeyDown={onKeyDown}
    />
  )
}

/** Horizontal separator that resizes the shared bottom-panel height. */
export function BottomPanelSash(): React.JSX.Element {
  return <PanelSash size={bottomPanelHeight} orientation="horizontal" label="Resize panel" className="vscode-bottom-panel__sash" />
}
