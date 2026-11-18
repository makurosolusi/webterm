// The one pointer-drag engine of the browser node: tab drags (strip -> pane, reorder, pop out) and pane drags (header ->
// pane) both run through `trackDrag`, and both read the same drop zones (`browserSplit.drop.ts`). It owns what is easy to get
// wrong twice: the movement threshold (a still press stays a click), Escape and pointercancel (abort, never drop), and
// the `data-bp-dragging` flag that turns the page surfaces inert so frames/pages never receive the drag's pointer events.
// Plain pointer events, no HTML5 DnD: the latter gives no pointercancel/Escape control, no custom ghost and fires nothing
// over a canvas that keeps pointer capture.

/** Movement before a press becomes a drag; below it a press stays a click. */
export const DRAG_THRESHOLD_PX = 4
/** Set on <body> while a drag runs; CSS makes `.browser-surface` ignore the pointer so hit tests see the panes. */
export const DRAGGING_ATTR = 'data-bp-dragging'

export interface DragHandlers {
  /** Pointer moved after the threshold was crossed (first call = the drag started). */
  move(ev: PointerEvent): void
  /** The drag is over. `started` false = a click that never moved; `commit` false = aborted (Escape / pointercancel). */
  end(r: { started: boolean; commit: boolean; ev?: PointerEvent }): void
}

/** Starts tracking a press at (x0, y0); returns a function that aborts it. */
export function trackDrag(x0: number, y0: number, h: DragHandlers): () => void {
  let started = false
  let done = false
  const finish = (commit: boolean, ev?: PointerEvent) => {
    if (done) return
    done = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    document.body.removeAttribute(DRAGGING_ATTR)
    h.end({ started, commit, ev })
  }
  function onMove(ev: PointerEvent) {
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return
      started = true
      document.body.setAttribute(DRAGGING_ATTR, '')
    }
    h.move(ev)
  }
  const onUp = (ev: PointerEvent) => finish(true, ev)
  const onCancel = () => finish(false)
  function onKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return
    if (started) { ev.preventDefault(); ev.stopPropagation() }
    finish(false)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
  return () => finish(false)
}
