import { describe, expect, it } from 'vitest'
import { lineEditSeq } from './terminalLineEdit'
import type { TerminalKeyEvent } from './terminalKeys'

function key(partial: Partial<TerminalKeyEvent> & { key: string }): TerminalKeyEvent {
  return {
    type: 'keydown',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  }
}

describe('lineEditSeq', () => {
  it('maps the mac Cmd chords to readline line editing', () => {
    expect(lineEditSeq(key({ key: 'Backspace', metaKey: true }), true)).toBe('\x15')
    expect(lineEditSeq(key({ key: 'ArrowLeft', metaKey: true }), true)).toBe('\x01')
    expect(lineEditSeq(key({ key: 'ArrowRight', metaKey: true }), true)).toBe('\x05')
  })

  it('maps Option+Delete to ESC d on mac', () => {
    expect(lineEditSeq(key({ key: 'Delete', altKey: true }), true)).toBe('\x1bd')
  })

  it('maps Ctrl+/ to ^_ on every platform', () => {
    expect(lineEditSeq(key({ key: '/', ctrlKey: true }), true)).toBe('\x1f')
    expect(lineEditSeq(key({ key: '/', ctrlKey: true }), false)).toBe('\x1f')
  })

  it('leaves Cmd+Up/Down, Shift+arrows and Option+Up/Down to xterm (TUIs use them)', () => {
    expect(lineEditSeq(key({ key: 'ArrowUp', metaKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowDown', metaKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowLeft', shiftKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowUp', altKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowDown', altKey: true }), true)).toBeNull()
  })

  it('ignores the mac-only chords off mac', () => {
    expect(lineEditSeq(key({ key: 'Backspace', metaKey: true }), false)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowLeft', metaKey: true }), false)).toBeNull()
    expect(lineEditSeq(key({ key: 'Delete', altKey: true }), false)).toBeNull()
  })

  it('rejects extra modifiers', () => {
    expect(lineEditSeq(key({ key: 'Backspace', metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowLeft', metaKey: true, altKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'ArrowRight', metaKey: true, ctrlKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: 'Delete', altKey: true, shiftKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: '/', ctrlKey: true, shiftKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: '/', ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(lineEditSeq(key({ key: '/', ctrlKey: true, metaKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ key: '/' }), true)).toBeNull()
  })

  it('never shadows the other Cmd chords (copy, paste, select-all, zoom, clean view)', () => {
    for (const k of ['c', 'v', 'a', '+', '=', '-', '0', '.', 'k']) {
      expect(lineEditSeq(key({ key: k, metaKey: true }), true)).toBeNull()
    }
  })

  it('only reacts to keydown', () => {
    expect(lineEditSeq(key({ type: 'keyup', key: 'Backspace', metaKey: true }), true)).toBeNull()
    expect(lineEditSeq(key({ type: 'keyup', key: '/', ctrlKey: true }), true)).toBeNull()
  })
})
