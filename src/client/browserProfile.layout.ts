// Grid layout for "open a browser for each profile": N nodes in rows and columns, never on top of each other
// and never on top of nodes already on the board. Pure (no DOM, no React Flow), flow coordinates.
import type { Rect, Size } from './browser.open.place'

/** Space between neighbouring nodes of the grid. */
export const GRID_GAP = 40

/** Columns for `count` nodes: the squarest grid that is not taller than wide (5 -> 3 columns, 2 rows). */
export const gridColumns = (count: number): number => Math.max(1, Math.ceil(Math.sqrt(count)))

/**
 * Top-left of each of `count` nodes of `size`. The block is centred on `center`; when it would cover an existing
 * node, the whole block moves down below that node (a grid stays together instead of being split around nodes).
 */
export function gridPositions(count: number, size: Size, center: { x: number; y: number }, others: readonly Rect[], gap = GRID_GAP): { x: number; y: number }[] {
  if (count <= 0) return []
  const cols = gridColumns(count)
  const rows = Math.ceil(count / cols)
  const block = { width: cols * size.width + (cols - 1) * gap, height: rows * size.height + (rows - 1) * gap }
  const x = center.x - block.width / 2
  let y = center.y - block.height / 2
  // One push per existing node at most: each push clears the node that caused it.
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => x < o.x + o.width && o.x < x + block.width && y < o.y + o.height && o.y < y + block.height)
    if (!hit) break
    y = hit.y + hit.height + gap
  }
  return Array.from({ length: count }, (_, i) => ({ x: x + (i % cols) * (size.width + gap), y: y + Math.floor(i / cols) * (size.height + gap) }))
}
