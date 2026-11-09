import { describe, expect, it } from 'vitest'
import { arrange } from './canvasArrange'
import { OPEN_GAP } from './canvasPlace'

const R = [
  { id: 'a', width: 100, height: 50 },
  { id: 'b', width: 200, height: 80 },
  { id: 'c', width: 150, height: 60 },
  { id: 'd', width: 120, height: 40 },
  { id: 'e', width: 90, height: 30 },
]

describe('arrange', () => {
  it('row: left to right, tops aligned, default OPEN_GAP between', () => {
    expect(arrange(R.slice(0, 3), 'row', { x: 10, y: 20 })).toEqual([
      { id: 'a', x: 10, y: 20 },
      { id: 'b', x: 10 + 100 + OPEN_GAP, y: 20 },
      { id: 'c', x: 10 + 300 + 2 * OPEN_GAP, y: 20 },
    ])
  })

  it('column: top to bottom, lefts aligned, custom gap', () => {
    expect(arrange(R.slice(0, 3), 'column', { x: 0, y: 0 }, 10)).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 60 },
      { id: 'c', x: 0, y: 150 },
    ])
  })

  it('grid: ceil(sqrt(n)) columns sized by the widest, rows by the tallest', () => {
    // 5 nodes -> 3 columns: [a b c] / [d e]; col widths 120,200,150; row heights 80,40.
    expect(arrange(R, 'grid', { x: 0, y: 0 }, 10)).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 130, y: 0 },
      { id: 'c', x: 340, y: 0 },
      { id: 'd', x: 0, y: 90 },
      { id: 'e', x: 130, y: 90 },
    ])
  })

  it('is deterministic and handles one or no node', () => {
    expect(arrange(R, 'grid', { x: 5, y: 5 })).toEqual(arrange(R, 'grid', { x: 5, y: 5 }))
    expect(arrange([R[0]], 'grid', { x: 7, y: 8 })).toEqual([{ id: 'a', x: 7, y: 8 }])
    expect(arrange([], 'row', { x: 0, y: 0 })).toEqual([])
  })
})
