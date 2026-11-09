import { describe, expect, it } from 'vitest'
import { keyBytes } from './canvas.type.keys'

describe('keyBytes', () => {
  it('maps named keys to xterm bytes', () => {
    expect(['Enter', 'Escape', 'Tab', 'BTab', 'Backspace', 'Delete', 'Space', 'Up', 'Down', 'Right', 'Left', 'Home', 'End', 'PageUp', 'PageDown'].map(keyBytes))
      .toEqual(['\r', '\x1b', '\t', '\x1b[Z', '\x7f', '\x1b[3~', ' ', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~'])
  })

  it('maps C-a..C-z to control bytes 1..26', () => {
    expect([keyBytes('C-a'), keyBytes('C-c'), keyBytes('C-z')]).toEqual(['\x01', '\x03', '\x1a'])
  })

  it('refuses unknown, raw and wrongly cased names', () => {
    for (const k of ['F13', '\x1b', 'c-c', 'C-C', 'C-1', 'escape', 'toString', 'constructor', '']) expect(keyBytes(k)).toBeUndefined()
  })
})
