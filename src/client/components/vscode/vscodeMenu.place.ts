// Pure placement of menu panels: where a context menu or a submenu goes inside the viewport. No DOM reads
// here (the caller measures), so the rules are testable without layout.
import { clamp } from './vscodeClamp'

export interface MenuSize { width: number; height: number }
export interface MenuViewport { width: number; height: number }
/** The parent panel's left/right edges and the top of the parent ROW, in viewport coordinates. */
export interface MenuParentBox { left: number; right: number; top: number }
/** Which side of its parent a submenu opened on; `none` for a context menu. */
export type MenuSide = 'right' | 'left' | 'none'
export interface MenuPlacement { left: number; top: number; side: MenuSide }

/** A context menu opens at the pointer; when it would not fit it flips to the other side of the point, then is clamped. */
export function placeContext(anchor: { x: number; y: number }, size: MenuSize, vp: MenuViewport, margin: number): MenuPlacement {
  const left = anchor.x + size.width > vp.width - margin ? anchor.x - size.width : anchor.x
  const top = anchor.y + size.height > vp.height - margin ? anchor.y - size.height : anchor.y
  return {
    left: clamp(left, margin, vp.width - size.width - margin),
    top: clamp(top, margin, vp.height - size.height - margin),
    side: 'none',
  }
}

/**
 * A submenu opens beside its parent row: to the RIGHT of the parent panel (overlapping its edge by `overlap`, the way
 * VS Code does), and to the LEFT of the parent panel only when the right side does not fit. Vertically its first row
 * lines up with the parent row; a submenu that would run off the bottom is shifted up, never flipped.
 */
export function placeSubmenu(parent: MenuParentBox, size: MenuSize, vp: MenuViewport, margin: number, overlap: number): MenuPlacement {
  const rightLeft = parent.right - overlap
  const fitsRight = rightLeft + size.width <= vp.width - margin
  const left = fitsRight ? rightLeft : parent.left + overlap - size.width
  return {
    left: clamp(left, margin, vp.width - size.width - margin),
    top: clamp(parent.top - overlap, margin, vp.height - size.height - margin),
    side: fitsRight ? 'right' : 'left',
  }
}
