// What canvas.screenshot clones. modern-screenshot copies every computed style of every element it
// clones, synchronously; cloning all of body (hidden panels, scrolled-out chat, off-screen nodes) froze
// the tab. The filter keeps the clone to what is on screen, and the pre-count refuses a page too big.

/** Bounds the synchronous style copy to roughly a second; above it the tab refuses instead of freezing. */
export const MAX_SHOT_ELEMENTS = 8000

export interface ShotViewport { width: number; height: number }

/** A box that clips overflowing content: its off-screen children cannot paint on screen.
 *  Overflow alone is not enough: `.react-flow__viewport` overflows (scrollWidth > clientWidth) with
 *  every node outside its box, but paints them all (overflow: visible), so its full-size
 *  `.react-flow__nodes` / `.react-flow__edges` boxes sit off-screen while their nodes are on screen. */
function clipsOverflow(el: Element | null): boolean {
  if (!el || (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)) return false
  const s = getComputedStyle(el)
  return s.overflowX !== 'visible' || s.overflowY !== 'visible'
}

/** modern-screenshot `filter`: false skips the node and its whole subtree. */
export function shotFilter(viewport: ShotViewport): (node: Node) => boolean {
  return (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return true
    const el = node as Element
    // checkVisibility() is false for any element without a box, and `display: contents` never has one
    // although its children paint (the terminal node's .tab-host-guard wraps the whole node body).
    if (el.checkVisibility?.() === false && getComputedStyle(el).display !== 'contents') return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return true
    const onScreen = r.right > 0 && r.bottom > 0 && r.left < viewport.width && r.top < viewport.height
    if (onScreen) return true
    // Only self-contained boxes: a container (.react-flow__viewport and the full-size boxes inside
    // it) can sit off-screen while its children are on screen.
    return !(el.matches('.react-flow__node') || clipsOverflow(el.parentElement))
  }
}

/** Elements under `root` the filter keeps (root excluded), capped at limit + 1. */
export function countShotElements(root: Element, filter: (node: Node) => boolean, limit: number): number {
  let count = 0
  const stack: Element[] = Array.from(root.children)
  while (stack.length) {
    const el = stack.pop()!
    if (!filter(el)) continue
    if (++count > limit) return count
    for (const child of Array.from(el.children)) stack.push(child)
  }
  return count
}
