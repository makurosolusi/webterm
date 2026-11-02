import { useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import './vscode-shell.css'

/** `horizontal` is a horizontal sash between stacked panes (the bottom panel case). */
export type VscodeSplitOrientation = 'horizontal' | 'vertical'

export interface VscodeSplitViewProps {
  /** Sash orientation; `horizontal` stacks panes top/bottom, `vertical` side by side. */
  orientation?: VscodeSplitOrientation
  /** Controlled size of the sized pane in pixels. */
  size: number
  onSizeChange: (size: number) => void
  /** Which pane `size` describes. A bottom panel passes `end`. */
  sizeFrom?: 'start' | 'end'
  minSize?: number
  maxSize?: number
  /** Restored by double-clicking the sash; defaults to 40% of the container. */
  defaultSize?: number
  start: ReactNode
  end: ReactNode
  className?: string
  ariaLabel?: string
  sashLabel?: string
}

const SASH_SIZE = 4
const KEYBOARD_STEP = 10
const KEYBOARD_LARGE_STEP = 50
const DEFAULT_RATIO = 0.4

/**
 * VS Code split view built on CSS grid with a 4px focusable sash.
 *
 * The size is controlled in pixels (`size` / `onSizeChange`) and clamped to
 * `minSize`/`maxSize` or the measured container. The sash is a real separator:
 * Arrow keys resize by 10px (Shift 50px), Home/End jump to the bounds, and
 * double-click restores `defaultSize` (40% by default). Dragging uses pointer
 * capture so the pointer never leaves the sash and text selection stays off.
 */
export function VscodeSplitView({
  orientation = 'horizontal',
  size,
  onSizeChange,
  sizeFrom = 'start',
  minSize = 0,
  maxSize,
  defaultSize,
  start,
  end,
  className,
  ariaLabel = 'Split view',
  sashLabel = 'Resize panes',
}: VscodeSplitViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startPosition: number; startSize: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const containerExtent = () => {
    const element = rootRef.current
    if (!element) return 0
    const rect = element.getBoundingClientRect()
    return orientation === 'horizontal' ? rect.height : rect.width
  }

  const clamp = (value: number) => {
    const min = Math.max(0, minSize)
    // An unmeasured container (jsdom, first paint) must not clamp to zero.
    const extent = containerExtent()
    const available = extent > 0 ? extent - SASH_SIZE : Number.POSITIVE_INFINITY
    const max = maxSize ?? available
    return Math.min(Math.max(value, min), Math.max(min, max))
  }

  const commit = (value: number) => {
    const next = Math.round(clamp(value))
    if (next !== size) onSizeChange(next)
  }

  const arrowDelta = (key: string, shift: boolean): number | null => {
    const step = shift ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP
    const sign = sizeFrom === 'end' ? 1 : -1
    if (orientation === 'horizontal') {
      if (key === 'ArrowUp') return step * sign
      if (key === 'ArrowDown') return -step * sign
    } else {
      if (key === 'ArrowLeft') return step * sign
      if (key === 'ArrowRight') return -step * sign
    }
    return null
  }

  const onSashKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = arrowDelta(event.key, event.shiftKey)
    if (delta !== null) {
      event.preventDefault()
      commit(size + delta)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      commit(minSize)
    } else if (event.key === 'End') {
      event.preventDefault()
      commit(Number.POSITIVE_INFINITY)
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      startPosition: orientation === 'horizontal' ? event.clientY : event.clientX,
      startSize: size,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const position = orientation === 'horizontal' ? event.clientY : event.clientX
    const delta = position - drag.startPosition
    commit(drag.startSize + (sizeFrom === 'end' ? -delta : delta))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const style = { '--vscode-split-size': `${size}px` } as CSSProperties

  return (
    <div
      ref={rootRef}
      className={['vscode-split-view', className].filter(Boolean).join(' ')}
      data-slot="vscode-split-view"
      data-orientation={orientation}
      data-size-from={sizeFrom}
      data-dragging={dragging ? 'true' : 'false'}
      style={style}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="vscode-split-view__pane" data-slot="vscode-split-view-start" data-pane="start">
        {start}
      </div>
      <div
        className="vscode-split-view__sash"
        data-slot="vscode-split-view-sash"
        role="separator"
        tabIndex={0}
        aria-label={sashLabel}
        aria-orientation={orientation}
        aria-valuenow={Math.round(size)}
        aria-valuemin={Math.max(0, minSize)}
        aria-valuemax={maxSize}
        onKeyDown={onSashKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          const fallback = Math.round(containerExtent() * DEFAULT_RATIO)
          commit(defaultSize ?? fallback)
        }}
      />
      <div className="vscode-split-view__pane" data-slot="vscode-split-view-end" data-pane="end">
        {end}
      </div>
    </div>
  )
}
