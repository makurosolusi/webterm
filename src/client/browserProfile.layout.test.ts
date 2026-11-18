// Grid layout of "open a browser for each profile": no overlaps, whole block clears existing nodes.
import { describe, expect, it } from 'vitest'
import { GRID_GAP, gridColumns, gridPositions } from './browserProfile.layout'

const size = { width: 640, height: 400 }
const overlap = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  a.x < b.x + size.width && b.x < a.x + size.width && a.y < b.y + size.height && b.y < a.y + size.height

describe('gridPositions', () => {
  it('uses the squarest grid: 5 nodes = 3 columns', () => {
    expect(gridColumns(5)).toBe(3)
    const spots = gridPositions(5, size, { x: 0, y: 0 }, [])
    expect(new Set(spots.map((s) => s.x)).size).toBe(3)
    expect(new Set(spots.map((s) => s.y)).size).toBe(2)
  })
  it('never overlaps, for every count', () => {
    for (let n = 1; n <= 12; n++) {
      const spots = gridPositions(n, size, { x: 100, y: 100 }, [])
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(overlap(spots[i], spots[j]), `${n}:${i},${j}`).toBe(false)
    }
  })
  it('moves the whole block below an existing node it would cover', () => {
    const existing = { x: -300, y: -200, width: 600, height: 400 }
    const spots = gridPositions(4, size, { x: 0, y: 0 }, [existing])
    for (const s of spots) expect(s.y).toBeGreaterThanOrEqual(existing.y + existing.height + GRID_GAP)
  })
  it('returns nothing for zero', () => { expect(gridPositions(0, size, { x: 0, y: 0 }, [])).toEqual([]) })
})
