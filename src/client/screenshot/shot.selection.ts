// Pure selection-rect logic (image pixels): drag in any direction, clamp, minimum size, 8-handle resize, move.
import type { Handle, Point, Rect, Size } from './shot.types'

/** Smallest selection edge the UI accepts, in image pixels. */
export const MIN_SELECTION_PX = 8
/** All handles, corners first so hit-testing prefers them. */
export const HANDLES: readonly Handle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The rectangle spanned by a drag from `a` to `b` in any direction, clamped to `bounds` (no minimum yet). */
export function dragRect(a: Point, b: Point, bounds: Size): Rect {
  const x1 = clamp(a.x, 0, bounds.w), x2 = clamp(b.x, 0, bounds.w)
  const y1 = clamp(a.y, 0, bounds.h), y2 = clamp(b.y, 0, bounds.h)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

/** Whether a selection is big enough to commit (both edges at least `min`). */
export const isSelectionValid = (r: Rect, min = MIN_SELECTION_PX): boolean => r.w >= min && r.h >= min

/** The edge pair for a moving edge `v` against fixed edge `f`: flips when crossed, keeps at least `min` apart. */
function span(f: number, v: number, min: number, hi: number): [number, number] {
  const a = clamp(v, 0, hi)
  if (Math.abs(a - f) >= min) return [Math.min(a, f), Math.max(a, f)]
  const dir = a >= f ? 1 : -1
  let b = f + dir * min
  if (b > hi || b < 0) b = f - dir * min
  return [Math.min(b, f), Math.max(b, f)]
}

/** Resize by dragging `handle` to `to`; the opposite edge stays fixed, crossing it flips the rect. */
export function resizeRect(rect: Rect, handle: Handle, to: Point, bounds: Size, min = MIN_SELECTION_PX): Rect {
  let [x1, x2] = [rect.x, rect.x + rect.w]
  let [y1, y2] = [rect.y, rect.y + rect.h]
  if (handle.includes('w')) [x1, x2] = span(x2, to.x, min, bounds.w)
  else if (handle.includes('e')) [x1, x2] = span(x1, to.x, min, bounds.w)
  if (handle.includes('n')) [y1, y2] = span(y2, to.y, min, bounds.h)
  else if (handle.includes('s')) [y1, y2] = span(y1, to.y, min, bounds.h)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Move by (dx, dy), stopped at the image edges (size unchanged). */
export function moveRect(rect: Rect, dx: number, dy: number, bounds: Size): Rect {
  return { ...rect, x: clamp(rect.x + dx, 0, Math.max(0, bounds.w - rect.w)), y: clamp(rect.y + dy, 0, Math.max(0, bounds.h - rect.h)) }
}

/** Handle anchor points of `rect` in image pixels. */
export function handlePoint(rect: Rect, h: Handle): Point {
  const x = h.includes('w') ? rect.x : h.includes('e') ? rect.x + rect.w : rect.x + rect.w / 2
  const y = h.includes('n') ? rect.y : h.includes('s') ? rect.y + rect.h : rect.y + rect.h / 2
  return { x, y }
}

/** The handle within `tolerance` of `p`, or null. */
export function hitHandle(rect: Rect, p: Point, tolerance: number): Handle | null {
  return HANDLES.find((h) => {
    const a = handlePoint(rect, h)
    return Math.abs(a.x - p.x) <= tolerance && Math.abs(a.y - p.y) <= tolerance
  }) ?? null
}

/** Whether `p` lies inside `rect` (edges included). */
export const insideRect = (rect: Rect, p: Point): boolean =>
  p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h

/** Readout such as "640x360" in whole image pixels. */
export const sizeLabel = (r: Rect): string => `${Math.round(r.w)}x${Math.round(r.h)}`
