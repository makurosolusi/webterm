// Pointer drag to reorder rail tiles (vertical twin of the browser tab strip's drag): the shared
// `trackDrag` engine owns the 4px threshold, Escape and pointercancel; this file adds the slot geometry.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { trackDrag } from './browserSplit/browserSplit.dnd'
import { reorderTarget } from './browserTabs/browserTabs.drag'

interface Span { top: number; bottom: number }

/** Insertion slot (0..n) for pointer y: the number of tiles whose midpoint lies above it. */
export function slotAtY(rects: Span[], y: number): number {
  return rects.filter((r) => (r.top + r.bottom) / 2 < y).length
}

export interface RailDragView {
  id: string
  /** Slot to draw the insertion line at; null when releasing would not move the tile. */
  slot: number | null
}

interface Opts {
  ids: string[]
  tileElements: () => HTMLElement[]
  onMove: (id: string, toIndex: number) => void
}

export function useRailDrag({ ids, tileElements, onMove }: Opts) {
  const [view, setView] = useState<RailDragView | null>(null)
  const latest = useRef({ ids, tileElements, onMove })
  latest.current = { ids, tileElements, onMove }
  const justDragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const begin = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return
    let slot: number | null = null
    stop.current?.()
    stop.current = trackDrag(e.clientX, e.clientY, {
      move: (ev) => {
        const { ids: list, tileElements: els } = latest.current
        const from = list.indexOf(id)
        const raw = slotAtY(els().map((el) => el.getBoundingClientRect()), ev.clientY)
        slot = reorderTarget(from, raw) === from ? null : raw
        setView({ id, slot })
      },
      end: ({ started, commit }) => {
        setView(null)
        if (!started) return
        // A real drag ends in a click on the same tile; the tile asks `wasDragged` to ignore that click.
        justDragged.current = true
        window.setTimeout(() => { justDragged.current = false }, 0)
        if (commit && slot !== null) latest.current.onMove(id, reorderTarget(latest.current.ids.indexOf(id), slot))
      },
    })
  }, [])

  return { view, begin, wasDragged: () => justDragged.current }
}
