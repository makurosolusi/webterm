import { describe, expect, test, vi } from 'vitest'
import { arrowGeometry, drawShape, renderScene, textBackground, type ShotFrame } from './shot.render'

// jsdom has no 2D context: record calls on a stub and assert what is drawn and how.
function fakeCtx() {
  const calls: string[] = []
  const rec = (n: string) => (...a: unknown[]) => { calls.push(`${n}(${a.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join(',')})`) }
  const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 10 }) } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : rec(k)),
    set: (t, k: string, v) => { t[k] = v; calls.push(`${k}=${String(v)}`); return true },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('shot render', () => {
  test('arrow head tip sits at `to`, base is behind it along the shaft', () => {
    const g = arrowGeometry({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, width: 4 })
    expect(g.base.y).toBeCloseTo(0); expect(g.base.x).toBeLessThan(100)
    expect(g.left.y).toBeCloseTo(-g.right.y)
  })
  test('thin arrows keep a minimum head', () => {
    const g = arrowGeometry({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, width: 1 })
    expect(100 - g.base.x).toBeGreaterThan(10)
  })
  test('marker is translucent source-over (no multiply), one stroke, thicker than pen', () => {
    const { ctx, calls } = fakeCtx()
    drawShape(ctx, { kind: 'marker', color: '#ff0', width: 4, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 0 }] })
    expect(calls.some((c) => c.startsWith('globalCompositeOperation'))).toBe(false)
    expect(calls).toContain('globalAlpha=0.4')
    expect(calls).toContain('lineWidth=16')
    expect(calls.filter((c) => c === 'stroke()')).toHaveLength(1)
  })
  test('pen uses curves', () => {
    const { ctx, calls } = fakeCtx()
    drawShape(ctx, { kind: 'pen', color: '#f00', width: 2, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 0 }, { x: 12, y: 3 }] })
    expect(calls.some((c) => c.startsWith('quadraticCurveTo'))).toBe(true)
  })
  test('text draws each line and an optional background', () => {
    const { ctx, calls } = fakeCtx()
    drawShape(ctx, { kind: 'text', color: '#fff', at: { x: 5, y: 5 }, text: 'a\nbb', size: 20, background: true })
    expect(calls.filter((c) => c.startsWith('fillText'))).toHaveLength(2)
    expect(calls.some((c) => c.startsWith('fillRect'))).toBe(true)
    expect(calls.some((c) => c.includes('system-ui'))).toBe(true)
  })
  test('text background contrasts with the text color', () => {
    expect(textBackground('#ffffff')).toContain('0,0,0')
    expect(textBackground('#000000')).toContain('255,255,255')
  })
  test('scene crops the frame, clips and translates shapes into crop space', () => {
    const { ctx, calls } = fakeCtx()
    const frame = { width: 200, height: 100 } as unknown as ShotFrame
    renderScene(ctx, frame, [{ kind: 'rect', color: '#f00', width: 2, from: { x: 60, y: 30 }, to: { x: 80, y: 50 } }], { selection: { x: 50, y: 20, w: 100, h: 60 }, scale: 2 })
    expect(calls).toContain('scale(2,2)')
    expect(calls.find((c) => c.startsWith('drawImage'))).toContain('50,20,100,60,0,0,100,60')
    expect(calls).toContain('translate(-50,-20)')
    expect(calls.indexOf('clip()')).toBeLessThan(calls.indexOf('translate(-50,-20)'))
    expect(vi.isMockFunction(ctx)).toBe(false)
  })
})
