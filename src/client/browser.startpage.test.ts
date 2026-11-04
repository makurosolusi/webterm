// Murni: batas zoom (resolusi ketikan omnibox: shared/browser.omnibox.test.ts).
import { describe, expect, it } from 'vitest'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, stepZoom, zoomLabel } from './browser.zoom'

describe('zoom', () => {
  it('steps by 10% without float drift and clamps to the limits', () => {
    expect(stepZoom(ZOOM_DEFAULT, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.2)
    expect(stepZoom(0.7, -1)).toBe(0.6)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    let z = ZOOM_DEFAULT
    for (let i = 0; i < 50; i++) z = stepZoom(z, 1)
    expect(z).toBe(ZOOM_MAX)
  })
  it('formats the percent label', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.1)).toBe('110%')
    expect(zoomLabel(0.5)).toBe('50%')
  })
})
