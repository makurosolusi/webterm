import { describe, expect, it } from 'vitest'
import { windowSurfacingViolation } from './cdp.windowGuard'
import { CdpClient } from './cdp.client'
import { windowPlacement } from './chromium.flags'

describe('window surfacing guard', () => {
  it.each(['Target.activateTarget', 'Page.bringToFront', 'Browser.setWindowBounds'])('refuses %s', (m) => {
    expect(windowSurfacingViolation(m, {})).toMatch(/surface or move/)
  })
  it('createTarget only as a background, unfocused, own window', () => {
    expect(windowSurfacingViolation('Target.createTarget', { url: 'about:blank' })).toBeDefined()
    expect(windowSurfacingViolation('Target.createTarget', { url: 'x', background: true })).toBeDefined()
    expect(windowSurfacingViolation('Target.createTarget', { url: 'x', ...windowPlacement('darwin') })).toBeUndefined()
    expect(windowSurfacingViolation('Target.createTarget', { url: 'x', ...windowPlacement('linux') })).toBeUndefined()
  })
  it('leaves other commands alone', () => {
    expect(windowSurfacingViolation('Browser.getWindowForTarget', { targetId: 'T' })).toBeUndefined()
    expect(windowSurfacingViolation('Page.navigate', { url: 'x' })).toBeUndefined()
  })
  it('CdpClient.send rejects before touching the socket', async () => {
    const sent: string[] = []
    const ws = { on: () => undefined, send: (f: string) => sent.push(f), readyState: 1, terminate: () => undefined }
    const c = new CdpClient(ws as never)
    await expect(c.send('Target.activateTarget', { targetId: 'T' })).rejects.toThrow(/refused/)
    await expect(c.send('Page.bringToFront', {}, 'S')).rejects.toThrow(/refused/)
    await expect(c.send('Target.createTarget', { url: 'x' })).rejects.toThrow(/refused/)
    expect(sent).toEqual([])
  })
})
