import { describe, expect, it } from 'vitest'
import { browserChord } from './browser.keys'
import { FIXED_COMMANDS } from './commandRegistry.defaults'

const k = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, key = '') =>
  ({ code, key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift })

describe('browserChord', () => {
  it.each([
    [k('KeyL', { meta: true }), 'focusUrl'],
    [k('KeyR', { meta: true }), 'reload'],
    [k('KeyR', { meta: true, shift: true }), 'hardReload'],
    [k('BracketLeft', { meta: true }), 'back'],
    [k('BracketRight', { meta: true }), 'forward'],
    [k('Equal', { meta: true }), 'zoomIn'],
    [k('Equal', { meta: true, shift: true }), 'zoomIn'],
    [k('NumpadAdd', { meta: true }), 'zoomIn'],
    [k('Minus', { meta: true }), 'zoomOut'],
    [k('NumpadSubtract', { meta: true }), 'zoomOut'],
    [k('Digit0', { meta: true }), 'zoomReset'],
    [k('Numpad0', { meta: true }), 'zoomReset'],
    [k('Escape', {}, 'Escape'), 'stop'],
    [k('KeyL', { ctrl: true }), null], // Ctrl is not primary on macOS
    [k('ArrowLeft', { alt: true }), null], // Alt+Left is word-jump on macOS
    [k('KeyL', { meta: true, alt: true }), null],
    [k('Minus', { meta: true, shift: true }), null],
    [k('KeyA', { meta: true }), null],
    [k('Escape', { shift: true }, 'Escape'), null],
  ])('macOS %o -> %s', (e, want) => expect(browserChord(e, true)).toBe(want))

  it.each([
    [k('KeyL', { ctrl: true }), 'focusUrl'],
    [k('KeyR', { ctrl: true }), 'reload'],
    [k('KeyR', { ctrl: true, shift: true }), 'hardReload'],
    [k('ArrowLeft', { alt: true }), 'back'],
    [k('ArrowRight', { alt: true }), 'forward'],
    [k('Equal', { ctrl: true }), 'zoomIn'],
    [k('NumpadAdd', { ctrl: true }), 'zoomIn'],
    [k('Minus', { ctrl: true }), 'zoomOut'],
    [k('Numpad0', { ctrl: true }), 'zoomReset'],
    [k('Escape', {}, 'Escape'), 'stop'],
    [k('BracketLeft', { ctrl: true }), null], // Ctrl+[ is Escape for terminals in the page
    [k('KeyL', { meta: true }), null],
    [k('KeyL', { ctrl: true, meta: true }), null],
    [k('ArrowLeft', { alt: true, shift: true }), null],
  ])('Windows/Linux %o -> %s', (e, want) => expect(browserChord(e, false)).toBe(want))

  it('every chord is listed in the Keyboard Shortcuts overlay (browser scope)', () => {
    const ids = FIXED_COMMANDS.filter((c) => c.scope === 'browser').map((c) => c.id)
    for (const id of ['focusUrl', 'reload', 'hardReload', 'back', 'forward', 'zoomIn', 'zoomOut', 'zoomReset', 'zoomPinch', 'stop']) {
      expect(ids).toContain(`browser.${id}`)
    }
  })
})
