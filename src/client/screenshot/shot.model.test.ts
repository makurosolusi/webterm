import { describe, expect, test } from 'vitest'
import { addShape, canRedo, canUndo, clearShapes, emptyState, redo, sanitizeShape, undo } from './shot.model'
import type { Shape } from './shot.types'

const rect: Shape = { kind: 'rect', color: '#f00', width: 4, from: { x: 0, y: 0 }, to: { x: 10, y: 5 } }
const line: Shape = { kind: 'line', color: '#f00', width: 4, from: { x: 0, y: 0 }, to: { x: 10, y: 5 } }

describe('shot model', () => {
  test('add keeps order; undo/redo move shapes between stacks; add drops redo', () => {
    let s = addShape(addShape(emptyState(), rect), line)
    expect(s.shapes).toEqual([rect, line])
    s = undo(s)
    expect(s.shapes).toEqual([rect]); expect(canRedo(s)).toBe(true)
    s = redo(s)
    expect(s.shapes).toEqual([rect, line]); expect(canRedo(s)).toBe(false)
    s = addShape(undo(s), rect)
    expect(s.redone).toEqual([])
  })
  test('undo/redo on empty are no-ops returning the same state', () => {
    const e = emptyState()
    expect(undo(e)).toBe(e); expect(redo(e)).toBe(e); expect(canUndo(e)).toBe(false)
  })
  test('clear empties both stacks', () => {
    const s = clearShapes(undo(addShape(addShape(emptyState(), rect), line)))
    expect(s).toEqual({ shapes: [], redone: [] })
  })
  test('invalid input is ignored at the boundary', () => {
    const e = emptyState()
    expect(addShape(e, { ...rect, to: { x: NaN, y: 1 } })).toBe(e)
    expect(addShape(e, { ...rect, to: { x: 10, y: 0 } })).toBe(e) // zero height
    expect(addShape(e, { ...line, from: line.kind === 'line' ? line.to : { x: 0, y: 0 } })).toBe(e) // zero length
    expect(addShape(e, { ...rect, width: 0 })).toBe(e)
    expect(addShape(e, { kind: 'text', color: '#000', at: { x: 0, y: 0 }, text: '  ', size: 20 })).toBe(e)
    expect(addShape(e, { kind: 'text', color: '#000', at: { x: 0, y: 0 }, text: 'hi', size: 0 })).toBe(e)
    expect(addShape(e, { kind: 'pen', color: '#000', width: 2, points: [{ x: NaN, y: 0 }] })).toBe(e)
  })
  test('pen drops NaN points but keeps the rest; text is trimmed', () => {
    const pen = sanitizeShape({ kind: 'pen', color: '#000', width: 2, points: [{ x: 1, y: 1 }, { x: NaN, y: 0 }, { x: 2, y: 2 }] })
    expect(pen).toMatchObject({ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })
    expect(sanitizeShape({ kind: 'text', color: '#000', at: { x: 0, y: 0 }, text: ' hi ', size: 12 })).toMatchObject({ text: 'hi' })
  })
})

import { MARKER_ALPHA, MARKER_DEFAULT_COLOR, SHOT_COLORS } from './shot.palette'
test('marker default is a preset color and alpha is translucent but visible', () => {
  expect(SHOT_COLORS.map((c) => c.value)).toContain(MARKER_DEFAULT_COLOR)
  expect(MARKER_ALPHA).toBeGreaterThanOrEqual(0.3); expect(MARKER_ALPHA).toBeLessThan(0.6)
})
