// Horizontal overflow of the tab scroller: which chevrons to enable, and smooth (or instant) scrolling.
import { useCallback, useEffect, useState, type RefObject } from 'react'

const SCROLL_STEP_RATIO = 0.6
const EDGE_SLACK_PX = 1

/** OS-level reduced-motion preference; false where matchMedia is missing. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface OverflowState { overflowing: boolean; canLeft: boolean; canRight: boolean }

/** Tracks overflow of `ref` (scroll, resize, and `watch` such as a tab-list signature) and exposes chevron scrolling. */
export function useTabOverflow(ref: RefObject<HTMLElement | null>, watch: string | number) {
  const [s, setS] = useState<OverflowState>({ overflowing: false, canLeft: false, canRight: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = {
      overflowing: el.scrollWidth > el.clientWidth + EDGE_SLACK_PX,
      canLeft: el.scrollLeft > EDGE_SLACK_PX,
      canRight: el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_SLACK_PX,
    }
    setS((prev) => (prev.overflowing === next.overflowing && prev.canLeft === next.canLeft && prev.canRight === next.canRight ? prev : next))
  }, [ref])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect() }
  }, [ref, measure, watch])
  const scroll = useCallback((dir: -1 | 1) => {
    const el = ref.current
    el?.scrollBy?.({ left: dir * el.clientWidth * SCROLL_STEP_RATIO, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [ref])
  return { ...s, scroll }
}
