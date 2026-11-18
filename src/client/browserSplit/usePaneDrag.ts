// Dragging a pane by its header onto another pane: the centre swaps, an edge moves the pane beside the target. Runs on the
// shared engine (`trackDrag`) and the shared zones (`paneHitAt`), the same as dragging a tab from the strip.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { trackDrag } from './browserSplit.dnd'
import { paneHitAt } from './browserSplit.drop'
import type { DropHint, DropZone } from './browserSplit.drop'

export interface PaneDragView {
  tabId: string
  /** Pointer position (viewport px) for the ghost. */
  x: number
  y: number
  /** Where releasing would land; null = outside every pane, on the pane itself, or a zone that cannot take it. */
  hit: DropHint | null
}

export interface PaneDragOpts {
  /** Whether `tabId` may land on `zone` of `target` (room left, not itself). */
  allowed: (tabId: string, target: string, zone: DropZone) => boolean
  onDrop: (tabId: string, target: string, zone: DropZone) => void
}

export function usePaneDrag(opts: PaneDragOpts) {
  const [view, setView] = useState<PaneDragView | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const justDragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const begin = useCallback((e: ReactPointerEvent, tabId: string) => {
    // Header buttons (device, close) keep their click; the title button is draggable too (it is most of the header).
    if (e.button !== 0 || (e.target as HTMLElement).closest('button:not([data-pane-title])')) return
    let hit: DropHint | null = null
    stop.current?.()
    stop.current = trackDrag(e.clientX, e.clientY, {
      move: (ev) => {
        const under = paneHitAt(ev.clientX, ev.clientY)
        const next = under && under.paneTabId !== tabId && latest.current.allowed(tabId, under.paneTabId, under.zone) ? under : null
        hit = next
        setView({ tabId, x: ev.clientX, y: ev.clientY, hit: next })
      },
      end: ({ started, commit }) => {
        stop.current = null
        const dropped = hit
        hit = null
        if (!started) return
        setView(null)
        justDragged.current = true // the click that follows the release must not open the title menu
        window.setTimeout(() => { justDragged.current = false }, 0)
        if (commit && dropped) latest.current.onDrop(tabId, dropped.paneTabId, dropped.zone)
      },
    })
  }, [])

  return { view, begin, wasDragged: () => justDragged.current }
}
