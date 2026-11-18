// Hidden header mode: reveal the header on a pointer push at the very top edge of the window.
//
// NO element: a window-level `pointermove` listener only. An invisible hover band along the edge
// would eat clicks on whatever the shell draws there (the lesson recorded in cleanView.css).
// Reveal needs the pointer at the edge for a dwell, with no button held (so a node drag to the top
// never reveals); hide comes a beat after the pointer left the header, and never while a menu is
// open or focus is inside it.
import { useEffect, useRef, useState } from 'react'

/** The pointer is "at the top edge" when `clientY` is at most this many px. */
export const REVEAL_EDGE_PX = 2
/** The pointer must stay at the edge this long before the header slides in. */
export const REVEAL_DWELL_MS = 250
/** The revealed header hides this long after the pointer left it. */
export const REVEAL_HIDE_MS = 500
/** Marks the header rows: the pointer inside one (or inside a menu opened from it) keeps it revealed. */
export const HEADER_REGION_ATTR = 'data-header-region'

const INSIDE = `[${HEADER_REGION_ATTR}], [role="menu"]`
const HELD_OPEN = `[${HEADER_REGION_ATTR}]:focus-within, [${HEADER_REGION_ATTR}] [aria-expanded="true"]`

/** True while the header is revealed over the canvas (always false unless `enabled`). */
export function useHeaderReveal(enabled: boolean): boolean {
  const [revealed, setRevealed] = useState(false)
  const shown = useRef(false)

  useEffect(() => {
    shown.current = revealed
  }, [revealed])

  useEffect(() => {
    if (!enabled) {
      setRevealed(false)
      return
    }
    let dwell: number | undefined
    let hide: number | undefined
    let pointerInside = false
    const cancel = (t: number | undefined): undefined => {
      window.clearTimeout(t)
      return undefined
    }
    const scheduleHide = (): void => {
      if (!shown.current || hide !== undefined) return
      hide = window.setTimeout(() => {
        hide = undefined
        if (pointerInside || document.querySelector(HELD_OPEN)) return
        setRevealed(false)
      }, REVEAL_HIDE_MS)
    }
    const onMove = (e: PointerEvent): void => {
      const atEdge = e.clientY <= REVEAL_EDGE_PX
      pointerInside = e.target instanceof Element && e.target.closest(INSIDE) !== null
      if (shown.current) {
        if (pointerInside || atEdge) hide = cancel(hide)
        else scheduleHide()
        return
      }
      if (atEdge && e.buttons === 0) {
        dwell ??= window.setTimeout(() => {
          dwell = undefined
          setRevealed(true)
        }, REVEAL_DWELL_MS)
      } else {
        dwell = cancel(dwell)
      }
    }
    const onLeave = (): void => {
      pointerInside = false
      dwell = cancel(dwell)
      scheduleHide()
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    document.addEventListener('focusout', scheduleHide)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('focusout', scheduleHide)
      cancel(dwell)
      cancel(hide)
    }
  }, [enabled])

  return enabled && revealed
}
