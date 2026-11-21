/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const domToCanvas = vi.fn()
vi.mock('modern-screenshot', () => ({ domToCanvas: (...a: unknown[]) => domToCanvas(...a), domToBlob: vi.fn() }))

import { captureFrame, captureScale, SHOT_MAX_PIXELS, SHOT_MAX_SIDE_PX } from './shot.capture'
import { planCapture, SHOT_IGNORE_ATTR } from '../canvasShot'

beforeEach(() => {
  domToCanvas.mockReset()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
})
afterEach(() => document.body.replaceChildren())

describe('shot capture', () => {
  test('scale is the device ratio, capped by side and pixel budget', () => {
    expect(captureScale(1000, 500, 2)).toBe(2)
    expect(captureScale(1000, 500, NaN)).toBe(1)
    expect(captureScale(8000, 100, 3) * 8000).toBeLessThanOrEqual(SHOT_MAX_SIDE_PX)
    const s = captureScale(6000, 5000, 3)
    expect(6000 * s * 5000 * s).toBeLessThanOrEqual(SHOT_MAX_PIXELS + 1)
  })
  test('captures a lossless canvas at native scale and reports it', async () => {
    const canvas = document.createElement('canvas')
    domToCanvas.mockResolvedValue(canvas)
    const r = await captureFrame()
    expect(r).toMatchObject({ ok: true, frame: canvas, cssWidth: 1000, cssHeight: 500, scale: 2 })
    expect(domToCanvas.mock.calls[0][1]).toMatchObject({ scale: 2, width: 1000, height: 500 })
  })
  test('a second capture while one runs is refused as busy', async () => {
    let release!: (c: HTMLCanvasElement) => void
    domToCanvas.mockReturnValue(new Promise((res) => { release = res }))
    const first = captureFrame()
    await new Promise((r) => setTimeout(r, 0))
    expect(await captureFrame()).toEqual({ ok: false, reason: 'busy' })
    release(document.createElement('canvas'))
    expect((await first).ok).toBe(true)
  })
  test('engine failure is a typed failure, not a throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    domToCanvas.mockRejectedValue(new Error('x'))
    expect(await captureFrame()).toEqual({ ok: false, reason: 'failed' })
  })
  test('elements marked data-shot-ignore are filtered out with their subtree', () => {
    document.body.innerHTML = `<div id="a"></div><div ${SHOT_IGNORE_ATTR}><span id="b"></span></div>`
    const plan = planCapture()!
    expect(plan.filter(document.getElementById('a')!)).toBe(true)
    expect(plan.filter(document.querySelector(`[${SHOT_IGNORE_ATTR}]`)!)).toBe(false)
  })
})
