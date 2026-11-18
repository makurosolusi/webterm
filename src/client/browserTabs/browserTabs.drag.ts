// Pointer drag for the tab strip: reorder inside the strip, or drop well below/above it to pop the tab out.
// Pure geometry (`reorderTarget`) plus a hook that owns the window listeners for one drag at a time.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { paneHitAt, type DropHint } from '../browserSplit/browserSplit.drop'

/** Movement before a press becomes a drag; below it a press stays a click. */
export const DRAG_THRESHOLD_PX = 4
/** Vertical distance outside the strip at which releasing pops the tab out. */
export const POP_OUT_DISTANCE_PX = 48

interface Span { left: number; right: number }

/** Insertion slot (0..n) for pointer x: the number of tabs whose midpoint lies left of it. */
export function slotAt(rects: Span[], x: number): number {
  return rects.filter((r) => (r.left + r.right) / 2 < x).length
}

/** Index the dragged tab ends at after removal from `from` and insertion at `slot`. */
export const reorderTarget = (from: number, slot: number): number => (slot > from ? slot - 1 : slot)

export interface DragView {
  tabId: string
  /** Insertion slot to draw the indicator at; null when releasing would not move the tab. */
  slot: number | null
  popOut: boolean
}

interface Opts {
  stripRef: RefObject<HTMLElement | null>
  tabIds: string[]
  tabElements: () => HTMLElement[]
  onReorder: (tabId: string, toIndex: number) => void
  onPopOut: (tabId: string) => void
  /** Split view: the pane (and zone) under the pointer while dragging, null when none; a drop on it is `onPaneDrop`. */
  onPaneHover?: (hit: DropHint | null) => void
  onPaneDrop?: (tabId: string, hit: DropHint) => void
}

export function useTabDrag({ stripRef, tabIds, tabElements, onReorder, onPopOut, onPaneHover, onPaneDrop }: Opts) {
  const [view, setView] = useState<DragView | null>(null)
  const latest = useRef({ tabIds, tabElements, onReorder, onPopOut, onPaneHover, onPaneDrop })
  latest.current = { tabIds, tabElements, onReorder, onPopOut, onPaneHover, onPaneDrop }
  const justDragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const begin = useCallback((e: ReactPointerEvent, tabId: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-tab-close]')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let current: DragView | null = null
    let hover: DropHint | null = null
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return
      const { tabIds: ids, tabElements: els } = latest.current
      const from = ids.indexOf(tabId)
      const slot = slotAt(els().map((el) => el.getBoundingClientRect()), ev.clientX)
      const box = stripRef.current?.getBoundingClientRect()
      const outside = box ? Math.max(box.top - ev.clientY, ev.clientY - box.bottom) : 0
      const hit = paneHitAt(ev.clientX, ev.clientY)
      if (hit?.paneTabId !== hover?.paneTabId || hit?.zone !== hover?.zone) latest.current.onPaneHover?.(hit)
      hover = hit
      // Over a pane the drop splits/assigns: neither a reorder slot nor a pop-out applies.
      current = { tabId, slot: hit || slot === from || slot === from + 1 ? null : slot, popOut: !hit && outside > POP_OUT_DISTANCE_PX }
      setView(current)
    }
    const finish = (commit: boolean) => {
      stop.current?.()
      stop.current = null
      const done = current
      const dropped = hover
      hover = null
      if (dropped) latest.current.onPaneHover?.(null)
      setView(null)
      if (!done) return
      justDragged.current = true // the click that follows the release must not activate
      window.setTimeout(() => { justDragged.current = false }, 0)
      if (!commit) return
      const { tabIds: ids, onReorder: reorder, onPopOut: popOut, onPaneDrop: paneDrop } = latest.current
      if (dropped) paneDrop?.(tabId, dropped)
      else if (done.popOut) popOut(tabId)
      else if (done.slot !== null) reorder(tabId, reorderTarget(ids.indexOf(tabId), done.slot))
    }
    const up = () => finish(true)
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true)
    stop.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true)
    }
  }, [stripRef])

  return { view, begin, wasDragged: () => justDragged.current }
}
