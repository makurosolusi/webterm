// Pointer drag to reorder the workspace tabs (the browser tab strip's twin): the shared `trackDrag` engine owns the
// 4px threshold, Escape and pointercancel; the slot geometry (`slotAt`, `reorderTarget`) is the browser strip's own.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { trackDrag } from './browserSplit/browserSplit.dnd'
import { reorderTarget, slotAt } from './browserTabs/browserTabs.drag'

export interface TabDragView {
  id: string
  /** Slot (0..n) to draw the insertion line at; null when releasing would not move the tab. */
  slot: number | null
}

interface Opts {
  ids: string[]
  onMove: (id: string, toIndex: number) => void
}

/** Selector of the tab cells of the strip a press happened in (DOM order = display order). */
const TAB_CELL = '[data-slot="vscode-editor-tab"]'
const STRIP = '[data-slot="vscode-editor-tabs"]'

export function useTabsDrag({ ids, onMove }: Opts) {
  const [view, setView] = useState<TabDragView | null>(null)
  const latest = useRef({ ids, onMove })
  latest.current = { ids, onMove }
  const justDragged = useRef(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const begin = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return
    const strip = (e.currentTarget as HTMLElement).closest(STRIP)
    if (!strip) return
    let slot: number | null = null
    stop.current?.()
    stop.current = trackDrag(e.clientX, e.clientY, {
      move: (ev) => {
        const from = latest.current.ids.indexOf(id)
        const rects = [...strip.querySelectorAll<HTMLElement>(TAB_CELL)].map((el) => el.getBoundingClientRect())
        const raw = slotAt(rects, ev.clientX)
        slot = reorderTarget(from, raw) === from ? null : raw
        setView({ id, slot })
      },
      end: ({ started, commit }) => {
        stop.current = null
        setView(null)
        if (!started) return
        // A real drag ends in a click on the same tab; the strip asks `wasDragged` to ignore that click.
        justDragged.current = true
        window.setTimeout(() => { justDragged.current = false }, 0)
        if (commit && slot !== null) latest.current.onMove(id, reorderTarget(latest.current.ids.indexOf(id), slot))
      },
    })
  }, [])

  return { view, begin, wasDragged: () => justDragged.current }
}

/** Where the insertion line of tab `index` (of `count`) is drawn for the drag in `view`. */
export function dropSide(view: TabDragView | null, index: number, count: number): 'before' | 'after' | undefined {
  const slot = view?.slot ?? null
  if (slot === null) return undefined
  if (slot === index) return 'before'
  return slot === count && index === count - 1 ? 'after' : undefined
}
