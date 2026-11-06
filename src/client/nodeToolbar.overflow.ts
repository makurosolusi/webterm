// Header action overflow, like a VS Code toolbar: the lower-priority actions sit in one clipping
// group that shrinks with the header; the ones that no longer fit are hidden and offered in the
// "…" menu instead. The group's layout never depends on the result (hidden items keep their box,
// only `visibility` changes), so measuring cannot feed back into itself.
import { useCallback, useState, type RefCallback } from 'react'

/** How many leading items fit: items are in priority order, `rightEdges[i]` is item i's right edge inside the group. */
export function fitCount(available: number, rightEdges: readonly number[]): number {
  const n = rightEdges.findIndex((edge) => edge > available)
  return n === -1 ? rightEdges.length : n
}

const measure = (group: HTMLElement): number =>
  fitCount(group.clientWidth, [...group.children].map((c) => (c as HTMLElement).offsetLeft + (c as HTMLElement).offsetWidth))

/** Ref for the clipping group + the number of its children that fit. Re-measures only when the group resizes or its items change. */
export function useFitCount(): [RefCallback<HTMLElement>, number] {
  const [count, setCount] = useState(Number.POSITIVE_INFINITY)
  const ref = useCallback((group: HTMLElement | null) => {
    // No ResizeObserver (non-browser test env): nothing can be measured, so every action stays inline.
    if (!group || typeof ResizeObserver === 'undefined') return
    const update = () => setCount(measure(group))
    const ro = new ResizeObserver(update)
    ro.observe(group)
    // An action can appear or go (e.g. Maximize in tab mode) while the clipped group keeps its size.
    const mo = new MutationObserver(update)
    mo.observe(group, { childList: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [])
  return [ref, count]
}
