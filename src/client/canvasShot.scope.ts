// What canvas.screenshot clones. modern-screenshot copies every computed style of every element it
// clones, synchronously; cloning all of body (hidden panels, scrolled-out chat, off-screen nodes) froze
// the tab. The filter keeps the clone to what is on screen, and the pre-count refuses a page too big.

/** Bounds the synchronous style copy to roughly a second; above it the tab refuses instead of freezing. */
export const MAX_SHOT_ELEMENTS = 8000

export interface ShotViewport { width: number; height: number }

const scrolls = (el: Element | null): boolean =>
  !!el && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)

/** modern-screenshot `filter`: false skips the node and its whole subtree. */
export function shotFilter(viewport: ShotViewport): (node: Node) => boolean {
  return (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return true
    const el = node as Element
    if (el.checkVisibility?.() === false) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return true
    const onScreen = r.right > 0 && r.bottom > 0 && r.left < viewport.width && r.top < viewport.height
    if (onScreen) return true
    // Only self-contained boxes: a transformed container (.react-flow__viewport) can sit off-screen
    // while its children are on screen.
    return !(el.matches('.react-flow__node') || scrolls(el.parentElement))
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
