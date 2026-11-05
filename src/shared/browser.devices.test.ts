import { describe, expect, it } from 'vitest'
import { VIEWPORT_MAX } from './browser.contract'
import { DEVICE_DIM_MAX, DEVICE_DIM_MIN, DEVICE_DPR_MAX, DEVICE_DPR_MIN, DEVICE_PRESETS, deviceLabel, parseDeviceChoice, resolveDevice } from './browser.devices'
import { parseClientMsg } from './browser.wire'

describe('device presets', () => {
  it('lists the DevTools-like presets with unique ids and sane values', () => {
    expect(DEVICE_PRESETS.map((p) => p.name)).toEqual([
      'iPhone SE', 'iPhone 15 Pro', 'iPhone 15 Pro Max', 'Pixel 8', 'Samsung Galaxy S23',
      'iPad Mini', 'iPad Air', 'iPad Pro 12.9"', 'Surface Pro', 'Desktop 1440', 'Desktop 1920',
    ])
    expect(new Set(DEVICE_PRESETS.map((p) => p.id)).size).toBe(DEVICE_PRESETS.length)
    for (const p of DEVICE_PRESETS) {
      expect(p.w).toBeGreaterThanOrEqual(DEVICE_DIM_MIN)
      expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(DEVICE_DIM_MAX)
      expect(p.dpr).toBeLessThanOrEqual(DEVICE_DPR_MAX)
    }
    expect(DEVICE_DIM_MAX).toBeLessThanOrEqual(VIEWPORT_MAX)
    expect(DEVICE_PRESETS.find((p) => p.id === 'iphone-se')?.ua).toMatch(/iPhone.*Mobile.*Safari/)
    expect(DEVICE_PRESETS.find((p) => p.id === 'pixel-8')?.ua).toMatch(/Android.*Chrome\/\d+.*Mobile Safari/)
    expect(DEVICE_PRESETS.find((p) => p.id === 'desktop-1920')).toMatchObject({ mobile: false, touch: false })
    expect(DEVICE_PRESETS.find((p) => p.id === 'desktop-1920')?.ua).toBeUndefined()
  })

  it('resolves a choice, rotating when landscape', () => {
    expect(resolveDevice({ id: 'iphone-15-pro' })).toMatchObject({ w: 393, h: 852, dpr: 3, landscape: false })
    expect(resolveDevice({ id: 'iphone-15-pro', landscape: true })).toMatchObject({ w: 852, h: 393, landscape: true })
    expect(resolveDevice({ id: 'custom', w: 300, h: 500, dpr: 2, landscape: true })).toMatchObject({ name: 'Custom', w: 500, h: 300 })
    expect(resolveDevice(null)).toBeNull()
    expect(resolveDevice(undefined)).toBeNull()
  })

  it('labels a device like the header shows it', () => {
    expect(deviceLabel(resolveDevice({ id: 'iphone-15-pro' })!)).toBe('iPhone 15 Pro · 393×852 · 3x')
  })

  it('validates custom bounds and rejects junk', () => {
    expect(parseDeviceChoice({ id: 'custom', w: DEVICE_DIM_MIN, h: DEVICE_DIM_MAX, dpr: DEVICE_DPR_MIN })).toEqual({ id: 'custom', w: DEVICE_DIM_MIN, h: DEVICE_DIM_MAX, dpr: DEVICE_DPR_MIN })
    for (const bad of [
      { id: 'custom', w: DEVICE_DIM_MIN - 1, h: 500, dpr: 1 },
      { id: 'custom', w: 500, h: DEVICE_DIM_MAX + 1, dpr: 1 },
      { id: 'custom', w: 500.5, h: 500, dpr: 1 },
      { id: 'custom', w: 500, h: 500, dpr: DEVICE_DPR_MAX + 0.1 },
      { id: 'custom', w: 500, h: 500, dpr: Number.NaN },
      { id: 'custom', w: 500, h: 500 },
      { id: 'nokia-3310' },
      { id: 'pixel-8', landscape: 'yes' },
      'pixel-8', [], undefined,
    ]) expect(parseDeviceChoice(bad)).toBeUndefined()
    expect(parseDeviceChoice(null)).toBeNull()
    expect(parseDeviceChoice({ id: 'pixel-8', ua: 'evil' })).toEqual({ id: 'pixel-8' }) // client never supplies a UA
  })

  it('parses the device wire message', () => {
    expect(parseClientMsg({ t: 'device', id: 'n1', device: { id: 'pixel-8', landscape: true } })).toEqual({ t: 'device', id: 'n1', device: { id: 'pixel-8', landscape: true } })
    expect(parseClientMsg({ t: 'device', id: 'n1', device: null })).toEqual({ t: 'device', id: 'n1', device: null })
    expect(parseClientMsg({ t: 'device', id: 'n1', device: { id: 'custom', w: 1, h: 1, dpr: 1 } })).toBeNull()
    expect(parseClientMsg({ t: 'device', id: 'n1' })).toBeNull()
  })
})
