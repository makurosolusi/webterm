import { describe, expect, it } from 'vitest'
import { DSF_MAX, MOD } from '../../shared/browser.contract'
import type { KeyInput, MouseInput } from '../../shared/browser.contract'
import { CDP } from './cdp.client'
import { clampDpr, metricsParams, toCdpCommands } from './browserHost.input'

const key = (o: Partial<KeyInput>): KeyInput => ({ t: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'a', vk: 65, mods: 0, ...o })
const mouse = (o: Partial<MouseInput>): MouseInput => ({ t: 'mouse', type: 'down', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1, mods: 0, dx: 0, dy: 0, ...o })

describe('toCdpCommands', () => {
  it('maps mouse down/up/move/wheel to CDP types and carries coordinates', () => {
    const types = (['down', 'up', 'move', 'wheel'] as const).map((type) => toCdpCommands(mouse({ type }))[0].params.type)
    expect(types).toEqual(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'])
    const [c] = toCdpCommands(mouse({ type: 'wheel', dx: 3, dy: -120, mods: MOD.Shift }))
    expect(c.method).toBe(CDP.mouse)
    expect(c.params).toMatchObject({ x: 10, y: 20, deltaX: 3, deltaY: -120, modifiers: 8, button: 'left' })
  })

  it('emits rawKeyDown then char for a printable key', () => {
    const cmds = toCdpCommands(key({}))
    expect(cmds.map((c) => c.params.type)).toEqual(['rawKeyDown', 'char'])
    expect(cmds[1].params).toMatchObject({ text: 'a', unmodifiedText: 'a', windowsVirtualKeyCode: 65 })
  })

  it('emits only rawKeyDown for Ctrl/Meta shortcuts (no char)', () => {
    expect(toCdpCommands(key({ mods: MOD.Ctrl })).map((c) => c.params.type)).toEqual(['rawKeyDown'])
    expect(toCdpCommands(key({ mods: MOD.Meta | MOD.Shift })).map((c) => c.params.type)).toEqual(['rawKeyDown'])
  })

  it('still sends char when only Alt/Shift are held', () => {
    expect(toCdpCommands(key({ mods: MOD.Shift, text: 'A' })).map((c) => c.params.type)).toEqual(['rawKeyDown', 'char'])
  })

  it('emits only rawKeyDown for non-text keys and keyUp on release', () => {
    expect(toCdpCommands(key({ key: 'Enter', code: 'Enter', text: '', vk: 13 })).map((c) => c.params.type)).toEqual(['rawKeyDown'])
    expect(toCdpCommands(key({ type: 'up' })).map((c) => c.params.type)).toEqual(['keyUp'])
  })

  it('maps text and IME input', () => {
    expect(toCdpCommands({ t: 'text', text: 'halo' })).toEqual([{ method: CDP.insertText, params: { text: 'halo' } }])
    expect(toCdpCommands({ t: 'ime', text: 'ni', start: 1, end: 2 })).toEqual([{ method: CDP.ime, params: { text: 'ni', selectionStart: 1, selectionEnd: 2 } }])
  })

  it('maps touch points, defaults force, and clears points on end/cancel', () => {
    const [start] = toCdpCommands({ t: 'touch', type: 'start', points: [{ x: 1, y: 2, id: 7 }] })
    expect(start.params).toEqual({ type: 'touchStart', touchPoints: [{ x: 1, y: 2, id: 7, force: 1 }] })
    for (const type of ['end', 'cancel'] as const) {
      expect(toCdpCommands({ t: 'touch', type, points: [{ x: 1, y: 2, id: 7 }] })[0].params.touchPoints).toEqual([])
    }
  })
})

describe('metrics', () => {
  it('clamps dpr to (0, DSF_MAX]', () => {
    expect(clampDpr(5)).toBe(DSF_MAX)
    expect(clampDpr(1.5)).toBe(1.5)
    expect(clampDpr(0)).toBeGreaterThan(0)
    expect(clampDpr(-3)).toBeGreaterThan(0)
  })
  it('rounds the viewport to whole CSS pixels', () => {
    expect(metricsParams(800.6, 600.2, 3)).toEqual({ width: 801, height: 600, deviceScaleFactor: DSF_MAX, mobile: false })
  })
})
