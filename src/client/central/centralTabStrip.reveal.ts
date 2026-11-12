// Control tab strip (CentralControlPanel): keep the active tab fully in view and mark which edges have more
// tabs (data-overflow="start|end|both", faded in central.css, like VS Code's tab strip shadows).
//
// Why not a scrollIntoView on tab change: the panel mounts while hidden (behind Chat, or before the lazy
// chunk is laid out) and stays mounted, so that one call ran at zero width and nothing re-ran when the strip
// became visible or narrower; `inline: 'nearest'` also left the tab flush against the edge, focus ring clipped.
// Here the reveal re-runs whenever the strip's size changes (ResizeObserver: shown, resized, fonts loaded).
import { useLayoutEffect, type RefObject } from 'react'

/** Gap kept between the active tab and the strip edge; wider than the edge fade so the fade never covers it. */
export const TAB_REVEAL_MARGIN = 24

/** Scrolls `list` so its active tab sits fully inside with `margin` to spare (when it fits at all). */
export function revealActiveTab(list: HTMLElement, margin = TAB_REVEAL_MARGIN): void {
  const tab = list.querySelector<HTMLElement>('[data-state="active"]')
  if (!tab) return
  const box = list.getBoundingClientRect()
  const r = tab.getBoundingClientRect()
  if (box.width === 0) return // hidden; the ResizeObserver runs this again once shown
  if (r.left < box.left + margin) list.scrollLeft -= box.left + margin - r.left
  else if (r.right > box.right - margin) list.scrollLeft += r.right - (box.right - margin)
}

/** "start" | "end" | "both" when tabs are cut off on that side, else undefined (1px slack for subpixels). */
export function overflowEdges(list: HTMLElement): 'start' | 'end' | 'both' | undefined {
  const start = list.scrollLeft > 1
  const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined
}

/** Wires both onto `listRef`: reveal on mount, on `activeKey` change and on resize; edges on scroll too. */
export function useTabStripReveal(listRef: RefObject<HTMLElement | null>, activeKey: string): void {
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const mark = (): void => {
      const edges = overflowEdges(list)
      if (edges) list.dataset.overflow = edges
      else delete list.dataset.overflow
    }
    const reveal = (): void => { revealActiveTab(list); mark() }
    reveal()
    list.addEventListener('scroll', mark, { passive: true })
    // jsdom has no ResizeObserver; the window resize listener covers it there.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal)
    ro?.observe(list)
    window.addEventListener('resize', reveal)
    void document.fonts?.ready.then(reveal) // tab widths change once the UI font lands
    return () => { list.removeEventListener('scroll', mark); ro?.disconnect(); window.removeEventListener('resize', reveal) }
  }, [listRef, activeKey])
}
