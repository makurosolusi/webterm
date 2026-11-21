// Pure annotation model: an ordered shape list with undo/redo. No DOM. Invalid shapes are dropped at
// the boundary (`sanitizeShape`), so the renderer never sees NaN, empty text or zero sizes.
import type { Point, Shape, ShotState } from './shot.types'

/** Empty state: nothing drawn, nothing to redo. */
export const emptyState = (): ShotState => ({ shapes: [], redone: [] })

const finite = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y)
const positive = (n: number): boolean => Number.isFinite(n) && n > 0
const apart = (a: Point, b: Point): boolean => finite(a) && finite(b) && (a.x !== b.x || a.y !== b.y)

/** A copy of `shape` that is safe to render, or null when it draws nothing (NaN point, empty text, zero size). */
export function sanitizeShape(shape: Shape): Shape | null {
  switch (shape.kind) {
    case 'pen':
    case 'marker': {
      const points = shape.points.filter(finite)
      return points.length > 0 && positive(shape.width) ? { ...shape, points } : null
    }
    case 'line':
    case 'arrow':
      return apart(shape.from, shape.to) && positive(shape.width) ? { ...shape } : null
    case 'rect':
      // A rect needs area: both axes must differ.
      return apart(shape.from, shape.to) && shape.from.x !== shape.to.x && shape.from.y !== shape.to.y && positive(shape.width)
        ? { ...shape } : null
    case 'text': {
      const text = shape.text.trim()
      return text !== '' && finite(shape.at) && positive(shape.size) ? { ...shape, text } : null
    }
  }
}

/** Append a shape (invalid ones are ignored) and drop the redo stack. */
export function addShape(state: ShotState, shape: Shape): ShotState {
  const clean = sanitizeShape(shape)
  return clean ? { shapes: [...state.shapes, clean], redone: [] } : state
}

/** Remove the newest shape; it can be redone. */
export function undo(state: ShotState): ShotState {
  if (state.shapes.length === 0) return state
  return { shapes: state.shapes.slice(0, -1), redone: [...state.redone, state.shapes[state.shapes.length - 1]] }
}

/** Put back the most recently undone shape. */
export function redo(state: ShotState): ShotState {
  if (state.redone.length === 0) return state
  return { shapes: [...state.shapes, state.redone[state.redone.length - 1]], redone: state.redone.slice(0, -1) }
}

/** Remove every shape and the redo stack. */
export function clearShapes(state: ShotState): ShotState {
  return state.shapes.length === 0 && state.redone.length === 0 ? state : emptyState()
}

/** Whether `undo` would change anything. */
export const canUndo = (state: ShotState): boolean => state.shapes.length > 0
/** Whether `redo` would change anything. */
export const canRedo = (state: ShotState): boolean => state.redone.length > 0
