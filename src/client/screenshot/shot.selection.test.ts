import { describe, expect, test } from 'vitest'
import { dragRect, handlePoint, hitHandle, insideRect, isSelectionValid, moveRect, resizeRect, sizeLabel } from './shot.selection'

const B = { w: 100, h: 80 }

describe('shot selection', () => {
  test('drag works in all four directions', () => {
    const want = { x: 10, y: 20, w: 30, h: 40 }
    expect(dragRect({ x: 10, y: 20 }, { x: 40, y: 60 }, B)).toEqual(want)
    expect(dragRect({ x: 40, y: 60 }, { x: 10, y: 20 }, B)).toEqual(want)
    expect(dragRect({ x: 40, y: 20 }, { x: 10, y: 60 }, B)).toEqual(want)
    expect(dragRect({ x: 10, y: 60 }, { x: 40, y: 20 }, B)).toEqual(want)
  })
  test('drag clamps to the image', () => {
    expect(dragRect({ x: -5, y: -5 }, { x: 500, y: 500 }, B)).toEqual({ x: 0, y: 0, w: 100, h: 80 })
  })
  test('minimum size', () => {
    expect(isSelectionValid({ x: 0, y: 0, w: 7, h: 50 })).toBe(false)
    expect(isSelectionValid({ x: 0, y: 0, w: 8, h: 8 })).toBe(true)
  })
  test('resize by corner and edge handles', () => {
    const r = { x: 20, y: 20, w: 40, h: 40 }
    expect(resizeRect(r, 'se', { x: 80, y: 70 }, B)).toEqual({ x: 20, y: 20, w: 60, h: 50 })
    expect(resizeRect(r, 'nw', { x: 10, y: 5 }, B)).toEqual({ x: 10, y: 5, w: 50, h: 55 })
    expect(resizeRect(r, 'e', { x: 90, y: 999 }, B)).toEqual({ x: 20, y: 20, w: 70, h: 40 })
    expect(resizeRect(r, 'n', { x: 999, y: 10 }, B)).toEqual({ x: 20, y: 10, w: 40, h: 50 })
  })
  test('resize clamps, flips over the fixed edge and keeps the minimum', () => {
    const r = { x: 20, y: 20, w: 40, h: 40 }
    expect(resizeRect(r, 'se', { x: 500, y: 500 }, B)).toEqual({ x: 20, y: 20, w: 80, h: 60 })
    expect(resizeRect(r, 'e', { x: 5, y: 0 }, B)).toEqual({ x: 5, y: 20, w: 15, h: 40 })
    expect(resizeRect(r, 'e', { x: 21, y: 0 }, B).w).toBe(8)
  })
  test('move stops at edges and keeps size', () => {
    const r = { x: 20, y: 20, w: 40, h: 40 }
    expect(moveRect(r, 100, 100, B)).toEqual({ x: 60, y: 40, w: 40, h: 40 })
    expect(moveRect(r, -100, -100, B)).toEqual({ x: 0, y: 0, w: 40, h: 40 })
  })
  test('handle points, hit-test and containment', () => {
    const r = { x: 10, y: 10, w: 20, h: 20 }
    expect(handlePoint(r, 'se')).toEqual({ x: 30, y: 30 })
    expect(handlePoint(r, 'n')).toEqual({ x: 20, y: 10 })
    expect(hitHandle(r, { x: 11, y: 29 }, 3)).toBe('sw')
    expect(hitHandle(r, { x: 20, y: 20 }, 3)).toBeNull()
    expect(insideRect(r, { x: 20, y: 20 })).toBe(true)
    expect(insideRect(r, { x: 31, y: 20 })).toBe(false)
  })
  test('size readout', () => expect(sizeLabel({ x: 0, y: 0, w: 640.4, h: 359.6 })).toBe('640x360'))
})
