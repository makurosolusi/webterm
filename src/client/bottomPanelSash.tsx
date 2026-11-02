// Resize sash on the top edge of the VS Code bottom panel: 4px hit area, `ns-resize`,
// pointer drag, and keyboard resize (ArrowUp/Down 10px, Shift 50px, Home/End = min/max).
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useRef } from 'react'
import {
  PANEL_MIN_HEIGHT, currentPanelHeight, heightAfterKey, panelMaxHeight, resetPanelHeight, setPanelHeight,
  usePanelHeight,
} from './bottomPanelHeight'

/** Panel height after dragging the sash by `deltaY` px (up = taller). */
export function heightAfterDrag(startHeight: number, startY: number, currentY: number): number {
  return startHeight + (startY - currentY)
}

/** Horizontal separator that resizes the shared bottom-panel height. */
export function BottomPanelSash(): React.JSX.Element {
  usePanelHeight() // re-render on height change so aria-valuenow follows
  const drag = useRef<{ height: number; y: number } | null>(null)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { height: currentPanelHeight(), y: event.clientY }
    // Optional call: jsdom has no pointer capture; real browsers keep the drag on the sash.
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start) setPanelHeight(heightAfterDrag(start.height, start.y, event.clientY))
  }
  const endDrag = (): void => { drag.current = null }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = heightAfterKey(event.key, event.shiftKey, currentPanelHeight())
    if (next === null) return
    event.preventDefault()
    setPanelHeight(next)
  }

  return (
    <div
      className="vscode-bottom-panel__sash"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel"
      aria-valuemin={PANEL_MIN_HEIGHT}
      aria-valuemax={panelMaxHeight()}
      aria-valuenow={currentPanelHeight()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetPanelHeight}
      onKeyDown={onKeyDown}
    />
  )
}
