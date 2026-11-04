import { describe, expect, it } from 'vitest'
import { isFrameCompatible } from './browser.stream.fit'

describe('isFrameCompatible', () => {
  const vp = { w: 1000, h: 700, dpr: 2 }
  it('accepts CSS, device (x dpr) and near sizes', () => {
    expect(isFrameCompatible({ width: 1000, height: 700 }, vp)).toBe(true)
    expect(isFrameCompatible({ width: 2000, height: 1400 }, vp)).toBe(true)
    expect(isFrameCompatible({ width: 2001, height: 1399 }, vp)).toBe(true)
  })
  it('accepts the device size scaled to fit the 2048 cap', () => {
    expect(isFrameCompatible({ width: 2048, height: 1092 }, { w: 1500, h: 800, dpr: 2 })).toBe(true) // 3000x1600 -> 2048x1092
  })
  it('rejects a transitional frame from the previous viewport', () => {
    expect(isFrameCompatible({ width: 800, height: 600 }, vp)).toBe(false)
    expect(isFrameCompatible({ width: 1000, height: 600 }, vp)).toBe(false)
  })
})
