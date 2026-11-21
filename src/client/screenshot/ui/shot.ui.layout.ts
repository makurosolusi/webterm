// Pure geometry of the annotator UI: where the tool rail and the action bar go, which cursor shows,
// and screen (CSS px) <-> image (frame px) conversion. No DOM, so every edge case is unit tested.
import type { Handle, Point, Rect, Size } from '../shot.types'

/** Edge length of a tool/action button, the gap between them and the padding of a bar, in CSS px. */
export const BTN_PX = 32
export const BAR_GAP_PX = 2
export const BAR_PAD_PX = 4
/** Distance between the selection and a bar, and between a bar and the viewport edge. */
export const BAR_OFFSET_PX = 8
export const VIEWPORT_MARGIN_PX = 8
/** Tool rail: pen, line, arrow, rect, marker, text, color, undo, redo. Action bar: copy, save, close. */
export const RAIL_ITEMS = 9
export const BAR_ITEMS = 3
/** Width of the color popover (swatch grid) beside the rail. */
export const POPOVER_W_PX = 156

export const barLength = (items: number): number => items * BTN_PX + (items - 1) * BAR_GAP_PX + 2 * BAR_PAD_PX
export const RAIL_SIZE: Size = { w: BTN_PX + 2 * BAR_PAD_PX, h: barLength(RAIL_ITEMS) }
export const BAR_SIZE: Size = { w: barLength(BAR_ITEMS), h: BTN_PX + 2 * BAR_PAD_PX }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Image px -> CSS px. */
export const toCss = (r: Rect, scale: number): Rect => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale })
/** Client point (CSS px) -> image px. */
export const toImage = (p: Point, scale: number): Point => ({ x: p.x * scale, y: p.y * scale })

export type RailSide = 'right' | 'left' | 'inside'

/** Vertical tool rail: right of the selection; flips to its left, then inside its right edge, when it does not fit. */
export function placeRail(sel: Rect, vp: Size, rail: Size = RAIL_SIZE): { x: number; y: number; side: RailSide } {
  const maxY = Math.max(VIEWPORT_MARGIN_PX, vp.h - rail.h - VIEWPORT_MARGIN_PX)
  const y = clamp(sel.y, VIEWPORT_MARGIN_PX, maxY)
  const right = sel.x + sel.w + BAR_OFFSET_PX
  if (right + rail.w <= vp.w - VIEWPORT_MARGIN_PX) return { x: right, y, side: 'right' }
  const left = sel.x - BAR_OFFSET_PX - rail.w
  if (left >= VIEWPORT_MARGIN_PX) return { x: left, y, side: 'left' }
  return { x: clamp(sel.x + sel.w - rail.w - BAR_OFFSET_PX, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, vp.w - rail.w - VIEWPORT_MARGIN_PX)), y, side: 'inside' }
}

/** Horizontal action bar: under the selection, right-aligned; moves up inside it when the viewport bottom is too close. */
export function placeBar(sel: Rect, vp: Size, bar: Size = BAR_SIZE): { x: number; y: number } {
  const x = clamp(sel.x + sel.w - bar.w, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, vp.w - bar.w - VIEWPORT_MARGIN_PX))
  const below = sel.y + sel.h + BAR_OFFSET_PX
  const y = below + bar.h <= vp.h - VIEWPORT_MARGIN_PX ? below : sel.y + sel.h - bar.h - BAR_OFFSET_PX
  return { x, y: clamp(y, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, vp.h - bar.h - VIEWPORT_MARGIN_PX)) }
}

/** Side of the rail the color popover opens on: toward the middle of the screen, where there is room. */
export const popoverSide = (railX: number, vpW: number): 'left' | 'right' =>
  railX >= POPOVER_W_PX + BAR_OFFSET_PX || railX > vpW / 2 ? 'left' : 'right'

/** Whether the size label fits above the selection (else it moves inside, under the top edge). */
export const labelFitsAbove = (sel: Rect): boolean => sel.y >= 24

const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }
/** Cursor for the pointer position: crosshair outside, resize on a handle, move inside without a tool, the tool's cursor inside with one. */
export function cursorFor(hit: { handle: Handle | null; inside: boolean }, tool: string | null, selecting: boolean): string {
  if (selecting) return 'crosshair'
  if (hit.handle) return CURSORS[hit.handle]
  if (!hit.inside) return 'crosshair'
  return tool === 'text' ? 'text' : tool ? 'crosshair' : 'move'
}
