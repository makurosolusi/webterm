import { describe, expect, it } from 'vitest'
import { placeContext, placeSubmenu } from './vscodeMenu.place'

const VP = { width: 1000, height: 700 }
const SIZE = { width: 200, height: 120 }
const MARGIN = 8
const OVERLAP = 4

describe('placeSubmenu', () => {
  it('opens to the RIGHT of the parent panel, overlapping its edge, first row level with the parent row', () => {
    const p = placeSubmenu({ left: 60, right: 260, top: 100 }, SIZE, VP, MARGIN, OVERLAP)
    expect(p).toEqual({ left: 256, top: 96, side: 'right' })
  })

  it('flips to the LEFT of the parent panel when the right side does not fit, never over the parent', () => {
    const p = placeSubmenu({ left: 700, right: 900, top: 100 }, SIZE, VP, MARGIN, OVERLAP)
    expect(p.side).toBe('left')
    expect(p.left).toBe(700 + OVERLAP - SIZE.width)
    expect(p.left + SIZE.width).toBe(700 + OVERLAP) // its right edge meets the parent panel's left edge (shared overlap)
  })

  it('stays right at the exact fit and flips one pixel later', () => {
    const edge = VP.width - MARGIN - SIZE.width + OVERLAP // parent.right at which the submenu just fits
    expect(placeSubmenu({ left: 0, right: edge, top: 0 }, SIZE, VP, MARGIN, OVERLAP).side).toBe('right')
    expect(placeSubmenu({ left: 0, right: edge + 1, top: 0 }, SIZE, VP, MARGIN, OVERLAP).side).toBe('left')
  })

  it('shifts up (never flips) when it would run off the bottom, and keeps the viewport margin at the top', () => {
    expect(placeSubmenu({ left: 60, right: 260, top: 680 }, SIZE, VP, MARGIN, OVERLAP).top).toBe(VP.height - SIZE.height - MARGIN)
    expect(placeSubmenu({ left: 60, right: 260, top: 0 }, SIZE, VP, MARGIN, OVERLAP).top).toBe(MARGIN)
  })

  it('clamps inside the viewport when the flipped panel would leave through the left edge', () => {
    const p = placeSubmenu({ left: 20, right: 990, top: 100 }, SIZE, VP, MARGIN, OVERLAP)
    expect(p.left).toBeGreaterThanOrEqual(MARGIN)
    expect(p.left + SIZE.width).toBeLessThanOrEqual(VP.width - MARGIN)
  })
})

describe('placeContext', () => {
  it('opens at the point when it fits', () => {
    expect(placeContext({ x: 50, y: 60 }, SIZE, VP, MARGIN)).toEqual({ left: 50, top: 60, side: 'none' })
  })

  it('flips to the other side of the point near the right and bottom edges, then clamps', () => {
    expect(placeContext({ x: 900, y: 650 }, SIZE, VP, MARGIN)).toEqual({ left: 700, top: 530, side: 'none' })
    expect(placeContext({ x: 1000, y: 700 }, SIZE, VP, MARGIN).left).toBe(VP.width - SIZE.width - MARGIN)
  })
})
