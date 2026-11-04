// QR encoder for the pairing link. The golden hash was produced by this encoder and decoded back to
// the same link by Apple CoreImage (CIDetectorTypeQRCode) before being pinned here; the structural
// checks catch a broken finder/timing/format layout without a decoder in the test env.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { qrMatrix, qrPath } from './telegramCardQr'

const LINK = 'https://t.me/webterm_test_bot?start=AbCdEf123456' // test-only
const bits = (m: boolean[][]): string => m.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('')

describe('qrMatrix', () => {
  it('encodes the pairing link to the decoder-verified matrix', () => {
    const m = qrMatrix(LINK)
    expect(m.length).toBe(33) // version 4
    expect(createHash('sha256').update(bits(m)).digest('hex')).toBe('c6042701ae192c5eee94239217a5d2bb947dd8841c27d941da98d0c7d6f53c5b')
  })

  it('picks the smallest version and keeps finder, timing and dark-module layout', () => {
    for (const [text, size] of [['hi', 21], ['x'.repeat(100), 41], ['x'.repeat(170), 53]] as const) {
      const m = qrMatrix(text)
      expect(m.length).toBe(size)
      for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
        expect(m[y]!.slice(x, x + 7)).toEqual(new Array(7).fill(true)) // finder top edge
        expect(m[y + 2]!.slice(x, x + 7)).toEqual([true, false, true, true, true, false, true])
      }
      for (let i = 8; i < size - 8; i++) expect(m[6]![i]).toBe(i % 2 === 0) // timing row
      expect(m[size - 8]![8]).toBe(true) // dark module
    }
  })

  it('refuses text past version 9 instead of emitting an unreadable code', () => {
    expect(() => qrMatrix('x'.repeat(400))).toThrow(/exceed/)
  })

  it('qrPath draws one unit square per dark module, offset by the quiet zone', () => {
    const m = qrMatrix('hi')
    const dark = m.flat().filter(Boolean).length
    const d = qrPath(m, 4)
    expect(d.match(/M/g)?.length).toBe(dark)
    expect(d.startsWith('M4,4h1v1h-1z')).toBe(true)
  })
})
