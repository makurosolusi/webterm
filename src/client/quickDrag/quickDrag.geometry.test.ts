import { describe, expect, it } from 'vitest'
import { edgeThickness, flowDelta, movedPosition, nearestCorner, resizedRect, screenRect, snap, zoneAt, type Rect, type Zone } from './quickDrag.geometry'

const at = (w: number, h: number): Rect => ({ x: 100, y: 50, width: w, height: h })

describe('zoneAt', () => {
  for (const [w, h] of [[400, 300], [1200, 900], [60, 40]]) {
    it(`finds every zone on a ${w}×${h} node`, () => {
      const r = at(w, h)
      const L = r.x + 1, R = r.x + w - 1, C = r.x + w / 2
      const T = r.y + 1, B = r.y + h - 1, M = r.y + h / 2
      const cases: [number, number, Zone][] = [
        [C, M, 'move'], [C, T, 'n'], [C, B, 's'], [L, M, 'w'], [R, M, 'e'],
        [L, T, 'nw'], [R, T, 'ne'], [L, B, 'sw'], [R, B, 'se'],
      ]
      for (const [x, y, z] of cases) expect(zoneAt(x, y, r)).toBe(z)
    })
  }

  it('edge band is max(10px, 20%) of the on-screen size', () => {
    expect(edgeThickness(400)).toBe(80)
    expect(edgeThickness(40)).toBe(10)
    const r = at(400, 300)
    expect(zoneAt(r.x + 79, r.y + 150, r)).toBe('w')
    expect(zoneAt(r.x + 81, r.y + 150, r)).toBe('move')
  })

  it('the middle never vanishes on a tiny node', () => {
    for (const s of [3, 9, 12, 20, 29]) {
      expect(edgeThickness(s)).toBeLessThan(s / 2)
      const r = at(s, s)
      expect(zoneAt(r.x + s / 2, r.y + s / 2, r)).toBe('move')
    }
  })

  it('a collapsed node (width only) has no top/bottom zones', () => {
    const r = at(400, 30)
    expect(zoneAt(r.x + 200, r.y + 1, r, 'x')).toBe('move')
    expect(zoneAt(r.x + 1, r.y + 1, r, 'x')).toBe('w')
    expect(zoneAt(r.x + 399, r.y + 29, r, 'x')).toBe('e')
  })
})

describe('nearestCorner', () => {
  it('picks the quadrant corner, width-only on a collapsed node', () => {
    const r = at(400, 300)
    expect(nearestCorner(r.x + 100, r.y + 100, r)).toBe('nw')
    expect(nearestCorner(r.x + 300, r.y + 100, r)).toBe('ne')
    expect(nearestCorner(r.x + 100, r.y + 200, r)).toBe('sw')
    expect(nearestCorner(r.x + 300, r.y + 200, r)).toBe('se')
    expect(nearestCorner(r.x + 300, r.y + 200, r, 'x')).toBe('e')
  })
})

describe('resizedRect', () => {
  const r: Rect = { x: 0, y: 0, width: 400, height: 300 }
  const min = { width: 240, height: 160 }
  it('each of the 8 handles grows from its edges and keeps the opposite edges put', () => {
    const grow: [Zone, Rect][] = [
      ['n', { x: 0, y: -20, width: 400, height: 320 }], ['s', { x: 0, y: 0, width: 400, height: 320 }],
      ['e', { x: 0, y: 0, width: 420, height: 300 }], ['w', { x: -20, y: 0, width: 420, height: 300 }],
      ['ne', { x: 0, y: -20, width: 420, height: 320 }], ['nw', { x: -20, y: -20, width: 420, height: 320 }],
      ['se', { x: 0, y: 0, width: 420, height: 320 }], ['sw', { x: -20, y: 0, width: 420, height: 320 }],
    ]
    for (const [z, want] of grow) {
      const dx = z.includes('w') ? -20 : 20
      const dy = z.includes('n') ? -20 : 20
      expect(resizedRect(r, z, dx, dy, min)).toEqual(want)
    }
  })

  it('never shrinks below the min, and the anchor edge stays put', () => {
    for (const z of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Zone[]) {
      const dx = z.includes('w') ? 1000 : -1000
      const dy = z.includes('n') ? 1000 : -1000
      const out = resizedRect(r, z, dx, dy, min)
      if (z.includes('e') || z.includes('w')) expect(out.width).toBe(240)
      if (z.includes('n') || z.includes('s')) expect(out.height).toBe(160)
      if (z.includes('e')) expect(out.x).toBe(0)
      if (z.includes('w')) expect(out.x + out.width).toBe(400)
      if (z.includes('s')) expect(out.y).toBe(0)
      if (z.includes('n')) expect(out.y + out.height).toBe(300)
    }
  })

  it('snaps the moving edge to the grid', () => {
    expect(resizedRect(r, 'se', 13, 30, min, [24, 24])).toEqual({ x: 0, y: 0, width: 408, height: 336 })
    expect(resizedRect(r, 'nw', -13, -30, min, [24, 24])).toEqual({ x: -24, y: -24, width: 424, height: 324 })
  })

  it('move zone leaves the rect alone', () => {
    expect(resizedRect(r, 'move', 50, 50, min)).toEqual(r)
  })
})

describe('move, snap and zoom', () => {
  it('moves by the delta and snaps the corner like React Flow', () => {
    expect(movedPosition({ x: 10, y: 10 }, 5, 7)).toEqual({ x: 15, y: 17 })
    expect(movedPosition({ x: 10, y: 10 }, 5, 7, [24, 24])).toEqual({ x: 24, y: 24 })
    expect(snap(35, 24)).toBe(24)
    expect(snap(37, 0)).toBe(37)
  })

  it('screen deltas are divided by zoom; screen rects scale with it', () => {
    expect(flowDelta(100, -50, 2)).toEqual({ dx: 50, dy: -25 })
    expect(flowDelta(100, -50, 0.5)).toEqual({ dx: 200, dy: -100 })
    expect(screenRect({ x: 10, y: 20, width: 400, height: 300 }, [5, 6, 0.5], { x: 100, y: 0 }))
      .toEqual({ x: 110, y: 16, width: 200, height: 150 })
  })
})
