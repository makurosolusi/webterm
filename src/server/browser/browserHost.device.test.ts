import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_PRESETS } from '../../shared/browser.devices'
import { CDP } from './cdp.client'
import { makeHostRig, stubGuard } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const callsOf = (method: string) => rig.fake.calls.filter((c) => c.method === method)
const last = (method: string) => callsOf(method).at(-1)?.params
const IPHONE = DEVICE_PRESETS.find((p) => p.id === 'iphone-15-pro')!

async function live(initialDevice?: (id: string) => unknown) {
  rig = await makeHostRig(stubGuard(), initialDevice ? { initialDevice } : {})
  await rig.host.open('n1', 'w1', 'https://example.com/')
  await rig.host.setViewport('n1', 800, 600, 1)
}

describe('device mode', () => {
  it('selecting a preset sends metrics, touch, touch-from-mouse and UA, then reloads', async () => {
    await live()
    const before = rig.fake.calls.length
    await rig.host.setDevice('n1', { id: 'iphone-15-pro' })
    expect(last(CDP.setDeviceMetrics)).toEqual({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    expect(last(CDP.setTouchEmulation)).toEqual({ enabled: true, maxTouchPoints: 10 })
    expect(last(CDP.setEmitTouch)).toEqual({ enabled: true, configuration: 'mobile' })
    expect(last(CDP.setUserAgent)).toEqual({ userAgent: IPHONE.ua, platform: 'iPhone' })
    const after = rig.fake.calls.slice(before).map((c) => c.method)
    expect(after.at(-1)).toBe(CDP.reload)
  })

  it('sends client hints for Android presets', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'pixel-8' })
    expect(last(CDP.setUserAgent)).toMatchObject({ userAgentMetadata: { platform: 'Android', mobile: true, model: 'Pixel 8' } })
  })

  it('ignores node resizes while a device is active', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'iphone-15-pro' })
    const n = callsOf(CDP.setDeviceMetrics).length
    await rig.host.setViewport('n1', 1200, 900, 2)
    expect(callsOf(CDP.setDeviceMetrics)).toHaveLength(n)
  })

  it('Responsive restores the latest node size and clears touch and UA overrides', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'iphone-15-pro' })
    await rig.host.setViewport('n1', 1200, 900, 2) // remembered, not applied
    await rig.host.setDevice('n1', null)
    expect(last(CDP.setDeviceMetrics)).toEqual({ width: 1200, height: 900, deviceScaleFactor: 2, mobile: false })
    expect(last(CDP.setTouchEmulation)).toEqual({ enabled: false })
    expect(last(CDP.setEmitTouch)).toEqual({ enabled: false })
    expect(last(CDP.setUserAgent)).toEqual({ userAgent: '' })
    expect(rig.fake.methods().at(-1)).toBe(CDP.reload)
    await rig.host.setViewport('n1', 700, 500, 1) // follows the node again
    expect(last(CDP.setDeviceMetrics)).toMatchObject({ width: 700, height: 500 })
  })

  it('rotate swaps width and height without reloading', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'iphone-15-pro' })
    const reloads = callsOf(CDP.reload).length
    await rig.host.setDevice('n1', { id: 'iphone-15-pro', landscape: true })
    expect(last(CDP.setDeviceMetrics)).toMatchObject({ width: 852, height: 393, screenOrientation: { type: 'landscapePrimary', angle: 90 } })
    expect(callsOf(CDP.reload)).toHaveLength(reloads)
  })

  it('the same device twice is a no-op', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'pixel-8' })
    const n = rig.fake.calls.length
    await rig.host.setDevice('n1', { id: 'pixel-8' })
    expect(rig.fake.calls).toHaveLength(n)
  })

  it('custom device uses its own size and DPR, desktop identity (no UA, no touch)', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'custom', w: 500, h: 700, dpr: 1.5 })
    expect(last(CDP.setDeviceMetrics)).toMatchObject({ width: 500, height: 700, deviceScaleFactor: 1.5, mobile: false })
    expect(last(CDP.setUserAgent)).toEqual({ userAgent: '' })
    expect(last(CDP.setTouchEmulation)).toEqual({ enabled: false })
  })

  it('restarts a running screencast with the device frame bounds', async () => {
    await live()
    await rig.host.startScreencast('n1', () => undefined)
    await rig.host.setDevice('n1', { id: 'iphone-15-pro' })
    // DPR 3 is emulated, but frames are capped at DSF_MAX (2): 393x2 = 786, 852x2 = 1704.
    expect(last(CDP.startScreencast)).toMatchObject({ maxWidth: 786, maxHeight: 1704 })
  })

  it('seeds the device saved on the board before the first navigation (survives restart)', async () => {
    await live((id) => (id === 'n1' ? { id: 'galaxy-s23', landscape: true } : undefined))
    const m = rig.fake.methods()
    expect(m.lastIndexOf(CDP.setUserAgent)).toBeLessThan(m.indexOf(CDP.navigate))
    expect(callsOf(CDP.setDeviceMetrics).find((c) => c.params.mobile === true)?.params).toMatchObject({ width: 780, height: 360, deviceScaleFactor: 3 })
    expect(m).not.toContain(CDP.reload)
  })

  it('re-applies the device on a reopened target (after discard)', async () => {
    await live()
    await rig.host.setDevice('n1', { id: 'ipad-air' })
    await rig.host.discard('n1')
    const before = rig.fake.calls.length
    await rig.host.open('n1', 'w1')
    const reopened = rig.fake.calls.slice(before)
    expect(reopened.find((c) => c.method === CDP.setDeviceMetrics && c.params.mobile === true)?.params).toMatchObject({ width: 820, height: 1180 })
  })

  it('an invalid saved device falls back to Responsive', async () => {
    await live(() => ({ id: 'custom', w: 10, h: 10, dpr: 1 }))
    expect(rig.fake.methods()).not.toContain(CDP.setUserAgent)
  })
})
