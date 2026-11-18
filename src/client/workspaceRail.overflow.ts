// "Do all tiles fit?" for the rail's workspace group. The group is the one flexible region of the rail,
// so the answer depends on the window height and the rest of the rail, never on a workspace count.
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Sub-pixel slack, same idea as `tabStripOverflow`: a fractional layout must not report phantom overflow. */
const OVERFLOW_SLACK_PX = 1

/** The tiles need more height than the group has. */
export const tilesOverflow = (scrollHeight: number, clientHeight: number): boolean => scrollHeight > clientHeight + OVERFLOW_SLACK_PX

/** Live overflow flag of `ref`'s element; re-measured on resize and whenever `dep` changes. */
export function useTilesOverflow(ref: RefObject<HTMLElement | null>, dep: unknown): boolean {
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflow(tilesOverflow(el.scrollHeight, el.clientHeight))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, dep])
  return overflow
}
