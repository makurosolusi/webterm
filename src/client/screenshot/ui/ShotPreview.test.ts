import { describe, expect, test } from 'vitest'
import type { ShotFrame } from '../shot.render'
import { DIM_FILL, paintPreview } from './ShotPreview'

// A recording stub: jsdom/node have no 2D context.
function fakeCtx() {
  const calls: string[] = []
  const rec = (n: string) => (...a: unknown[]) => { calls.push(`${n}(${a.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : typeof v === 'object' ? 'obj' : v)).join(',')})`) }
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : rec(k)),
    set: (t, k: string, v) => { t[k] = v; calls.push(`${k}=${String(v)}`); return true },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}
const frame = { width: 2000, height: 1200 } as ShotFrame
const base = { frame, css: { w: 1000, h: 600 }, scale: 2, shapes: [], draft: null }

describe('paintPreview', () => {
  test('without a selection: the whole frame, dimmed', () => {
    const { ctx, calls } = fakeCtx()
    paintPreview(ctx, { ...base, selection: null }, 2)
    expect(calls).toContain('setTransform(2,0,0,2,0,0)')
    expect(calls).toContain('drawImage(obj,0,0,1000,600)')
    expect(calls).toContain(`fillStyle=${DIM_FILL}`)
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(1)
  })

  test('with a selection: the crop is drawn bright at its CSS position on top of the dim layer', () => {
    const { ctx, calls } = fakeCtx()
    paintPreview(ctx, { ...base, selection: { x: 200, y: 100, w: 400, h: 300 } }, 1)
    expect(calls).toContain('translate(100,50)') // image px / scale
    expect(calls).toContain('drawImage(obj,200,100,400,300,0,0,400,300)') // renderScene's crop
    expect(calls).toContain('scale(0.5,0.5)') // drawn in CSS px
    expect(calls.indexOf(`fillStyle=${DIM_FILL}`)).toBeLessThan(calls.indexOf('drawImage(obj,200,100,400,300,0,0,400,300)'))
  })

  test('the draft shape is painted with the committed ones', () => {
    const { ctx, calls } = fakeCtx()
    const draft = { kind: 'rect' as const, color: '#f00', width: 4, from: { x: 210, y: 110 }, to: { x: 300, y: 200 } }
    paintPreview(ctx, { ...base, selection: { x: 200, y: 100, w: 400, h: 300 }, draft }, 1)
    expect(calls.some((c) => c.startsWith('strokeRect'))).toBe(true)
  })
})
