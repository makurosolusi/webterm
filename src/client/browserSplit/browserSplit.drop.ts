// Drop zones of a pane while a tab is dragged over it (VS Code editor groups): the outer quarter of each side splits on
// that side, the middle shows the tab in that pane. Pure geometry plus the DOM lookup of the pane under the pointer.
import type { DropEdge } from '../../shared/browser.layout'

export type DropZone = DropEdge | 'center'
export interface DropHint { paneTabId: string; zone: DropZone }

/** Share of a pane's width/height, per side, that counts as an edge zone. */
export const EDGE_SHARE = 0.25

interface Box { left: number; top: number; width: number; height: number }

/** Zone under (x, y) inside `box`; the nearest edge wins in a corner. */
export function dropZoneAt(box: Box, x: number, y: number): DropZone {
  if (box.width <= 0 || box.height <= 0) return 'center'
  const fx = (x - box.left) / box.width
  const fy = (y - box.top) / box.height
  const dist: Array<[DropEdge, number]> = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
  const [edge, d] = dist.reduce((a, b) => (b[1] < a[1] ? b : a))
  return d < EDGE_SHARE ? edge : 'center'
}

/** The pane (by tab id) under the pointer and the zone it is in; null when the pointer is not over a pane. */
export function paneHitAt(x: number, y: number, doc: Document = document): DropHint | null {
  const pane = doc.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-pane-tab]')
  const paneTabId = pane?.dataset.paneTab
  if (!pane || !paneTabId) return null
  return { paneTabId, zone: dropZoneAt(pane.getBoundingClientRect(), x, y) }
}

/** Overlay rectangle (percent of the pane) previewing where the dropped tab will land. */
export function zoneBox(zone: DropZone): { left: string; top: string; width: string; height: string } {
  switch (zone) {
    case 'left': return { left: '0%', top: '0%', width: '50%', height: '100%' }
    case 'right': return { left: '50%', top: '0%', width: '50%', height: '100%' }
    case 'top': return { left: '0%', top: '0%', width: '100%', height: '50%' }
    case 'bottom': return { left: '0%', top: '50%', width: '100%', height: '50%' }
    case 'center': return { left: '0%', top: '0%', width: '100%', height: '100%' }
  }
}
