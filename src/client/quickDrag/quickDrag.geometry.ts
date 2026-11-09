// Pure geometry of the quick move & resize gesture: which zone of a node the pointer is in, and the
// rect a drag from that zone produces. Screen px in, flow units out; no DOM, no React Flow.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
/** `move` = middle; otherwise the edges being dragged (n/s top/bottom, e/w right/left). */
export type Zone = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
/** `x` = width only (a collapsed node: its height is the header). */
export type Axes = 'both' | 'x'

/** Edge zone floor in screen px, and its share of the node's on-screen size. */
const MIN_EDGE_PX = 10
const EDGE_FRACTION = 0.2

/** React Flow `snapGrid` ([x, y]); undefined = snapping off. */
export type Grid = readonly [number, number] | undefined

/** Edge zone thickness along one side: max(10px, 20%), capped at a third so the middle never vanishes. */
export function edgeThickness(size: number): number {
  return Math.min(Math.max(MIN_EDGE_PX, size * EDGE_FRACTION), size / 3)
}

const zoneOf = (top: boolean, bottom: boolean, left: boolean, right: boolean, axes: Axes): Zone => {
  const v = axes === 'x' ? '' : top ? 'n' : bottom ? 's' : ''
  const h = left ? 'w' : right ? 'e' : ''
  return ((v + h) || 'move') as Zone
}

/** Zone under screen point (px, py) of a node drawn at screen rect `r`. */
export function zoneAt(px: number, py: number, r: Rect, axes: Axes = 'both'): Zone {
  const lx = px - r.x
  const ly = py - r.y
  const tx = edgeThickness(r.width)
  const ty = edgeThickness(r.height)
  return zoneOf(ly < ty, ly > r.height - ty, lx < tx, lx > r.width - tx, axes)
}

/** Corner nearest to (px, py): the right-button gesture always resizes from one. */
export function nearestCorner(px: number, py: number, r: Rect, axes: Axes = 'both'): Zone {
  const top = py - r.y < r.height / 2
  const left = px - r.x < r.width / 2
  return zoneOf(top, !top, left, !left, axes)
}

/** React Flow's `snapPosition` rounding; `grid` 0/undefined = no snap. */
export const snap = (v: number, grid?: number): number => (grid ? grid * Math.round(v / grid) : v)

/** Screen-px pointer delta as flow units at `zoom`. */
export const flowDelta = (dx: number, dy: number, zoom: number): { dx: number; dy: number } => ({ dx: dx / zoom, dy: dy / zoom })

/** Screen rect of a node at flow rect `r` under viewport transform [tx, ty, zoom], pane at `origin`. */
export function screenRect(r: Rect, [tx, ty, zoom]: readonly [number, number, number], origin = { x: 0, y: 0 }): Rect {
  return { x: origin.x + tx + r.x * zoom, y: origin.y + ty + r.y * zoom, width: r.width * zoom, height: r.height * zoom }
}

/** Position after moving by a flow delta; the moved corner snaps to the grid like a header drag. */
export function movedPosition(p: { x: number; y: number }, dx: number, dy: number, grid?: Grid): { x: number; y: number } {
  return { x: snap(p.x + dx, grid?.[0]), y: snap(p.y + dy, grid?.[1]) }
}

/** One axis: `lo` moves the start edge, `hi` the end edge; the other edge is the anchor. */
function axis(start: number, size: number, d: number, min: number, lo: boolean, hi: boolean, grid?: number): [number, number] {
  if (hi) return [start, Math.max(min, snap(start + size + d, grid) - start)]
  if (lo) {
    const end = start + size
    const next = Math.max(min, end - snap(start + d, grid))
    return [end - next, next]
  }
  return [start, size]
}

/** Rect after dragging `zone` by a flow delta: never below `min`, the opposite edge stays put. */
export function resizedRect(r: Rect, zone: Zone, dx: number, dy: number, min: Size, grid?: Grid): Rect {
  if (zone === 'move') return r
  const [x, width] = axis(r.x, r.width, dx, min.width, zone.includes('w'), zone.includes('e'), grid?.[0])
  const [y, height] = axis(r.y, r.height, dy, min.height, zone.includes('n'), zone.includes('s'), grid?.[1])
  return { x, y, width, height }
}
