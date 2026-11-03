import { describe, it, expect } from 'vitest'
import { toPagePoint } from './browser.coords'

const viewport = { w: 1280, h: 720 }

describe('toPagePoint', () => {
  // Canvas 800x450 CSS px di layout; rect berskala = layout * zoom React Flow, tergeser (pan).
  it.each([0.25, 1, 4])('titik tengah dan sudut benar pada zoom %s dengan rect tergeser', (zoom) => {
    const rect = { left: 137, top: -42, width: 800 * zoom, height: 450 * zoom }
    const at = (fx: number, fy: number) =>
      toPagePoint(rect, { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy }, viewport)
    const mid = at(0.5, 0.5)!
    expect(mid.x).toBeCloseTo(640, 6)
    expect(mid.y).toBeCloseTo(360, 6)
    expect(at(0, 0)).toEqual({ x: 0, y: 0 })
    const br = at(1, 1)!
    expect(br.x).toBeCloseTo(1280, 6)
    expect(br.y).toBeCloseTo(720, 6)
  })

  it('tidak dijepit: klien di luar rect memberi koordinat di luar viewport (drag keluar)', () => {
    const p = toPagePoint({ left: 100, top: 100, width: 100, height: 100 }, { x: 50, y: 250 }, { w: 200, h: 200 })!
    expect(p).toEqual({ x: -100, y: 300 })
  })

  it('rect nol/negatif, viewport nol, atau angka non-finite -> null', () => {
    const c = { x: 10, y: 10 }
    expect(toPagePoint({ left: 0, top: 0, width: 0, height: 100 }, c, viewport)).toBeNull()
    expect(toPagePoint({ left: 0, top: 0, width: 100, height: 0 }, c, viewport)).toBeNull()
    expect(toPagePoint({ left: 0, top: 0, width: -5, height: 100 }, c, viewport)).toBeNull()
    expect(toPagePoint({ left: 0, top: 0, width: 100, height: 100 }, c, { w: 0, h: 10 })).toBeNull()
    expect(toPagePoint({ left: 0, top: 0, width: 100, height: 100 }, { x: NaN, y: 1 }, viewport)).toBeNull()
    expect(toPagePoint({ left: 0, top: 0, width: Infinity, height: 100 }, c, viewport)).toBeNull()
  })
})
