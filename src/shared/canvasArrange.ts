// Tidy layouts for a set of canvas nodes (pure: no DOM/RF). Used by Central's canvas.edit `arrange` op.
import { OPEN_GAP, type XY } from './canvasPlace'

export type ArrangeLayout = 'grid' | 'row' | 'column'
export const ARRANGE_LAYOUTS: readonly ArrangeLayout[] = ['grid', 'row', 'column']

const sum = (xs: number[], end: number): number => xs.slice(0, end).reduce((a, b) => a + b, 0)

/**
 * Top-left corner of each rect, in input order, starting at `origin` with `gap` between neighbours.
 * `row` = one line left to right, `column` = one stack top to bottom, `grid` = ceil(sqrt(n)) columns
 * filled row by row, each column as wide as its widest node and each row as tall as its tallest
 * (nodes sit at the top-left of their cell).
 */
export function arrange(rects: ReadonlyArray<{ id: string; width: number; height: number }>, layout: ArrangeLayout, origin: XY, gap = OPEN_GAP): Array<{ id: string } & XY> {
  const n = rects.length
  const cols = layout === 'row' ? n : layout === 'column' ? 1 : Math.ceil(Math.sqrt(n))
  const colW: number[] = []
  const rowH: number[] = []
  rects.forEach((r, i) => {
    const c = i % cols
    const row = Math.floor(i / cols)
    colW[c] = Math.max(colW[c] ?? 0, r.width)
    rowH[row] = Math.max(rowH[row] ?? 0, r.height)
  })
  return rects.map((r, i) => {
    const c = i % cols
    const row = Math.floor(i / cols)
    return { id: r.id, x: origin.x + sum(colW, c) + c * gap, y: origin.y + sum(rowH, row) + row * gap }
  })
}
