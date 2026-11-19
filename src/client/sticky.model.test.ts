import { describe, expect, it } from 'vitest'
import { STICKY_TEXT_MAX } from '../shared/sticky.palette'
import { STICKY_FONT_MIN, stickyCounterVisible, stickyFontSize, stickyOverflows, stickyRowLabel, stickyTilt } from './sticky.model'

describe('stickyFontSize', () => {
  it('writes short text big and long text smaller, never below the minimum', () => {
    const short = stickyFontSize('Ship it', 180, 180)
    const medium = stickyFontSize('Remember to rotate the staging token before Friday', 180, 180)
    const long = stickyFontSize('word '.repeat(400), 180, 180)
    expect(short).toBeGreaterThan(medium)
    expect(medium).toBeGreaterThan(long)
    expect(long).toBe(STICKY_FONT_MIN)
  })

  it('steps down monotonically as the text grows', () => {
    let prev = Infinity
    for (let n = 0; n <= 600; n += 20) {
      const f = stickyFontSize('x'.repeat(n), 180, 180)
      expect(f).toBeLessThanOrEqual(prev)
      prev = f
    }
  })

  it('a bigger note lets the same text be written bigger', () => {
    const text = 'Remember to rotate the staging token before Friday'
    expect(stickyFontSize(text, 320, 320)).toBeGreaterThan(stickyFontSize(text, 180, 180))
  })

  it('reports overflow only when even the minimum font does not fit', () => {
    expect(stickyOverflows('short', 180, 180)).toBe(false)
    expect(stickyOverflows('word '.repeat(400), 180, 180)).toBe(true)
  })

  it('an empty note gets the largest font', () => {
    expect(stickyFontSize('', 180, 180)).toBe(44)
  })
})

describe('stickyTilt', () => {
  it('is deterministic per id and stays within +-2.5 degrees', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `node-${i * 7919}`)
    for (const id of ids) {
      expect(stickyTilt(id)).toBe(stickyTilt(id))
      expect(Math.abs(stickyTilt(id))).toBeLessThanOrEqual(2.5)
    }
    expect(new Set(ids.map(stickyTilt)).size).toBeGreaterThan(5)
  })
})

describe('stickyRowLabel', () => {
  it('is the first non-empty line, capped, else the kind name', () => {
    expect(stickyRowLabel('\n  Fix login\nmore')).toBe('Fix login')
    expect(stickyRowLabel('x'.repeat(100))).toHaveLength(40)
    expect(stickyRowLabel('')).toBe('Sticky note')
    expect(stickyRowLabel(undefined)).toBe('Sticky note')
    expect(stickyRowLabel('  \n ')).toBe('Sticky note')
  })
})

describe('stickyCounterVisible', () => {
  it('shows from 90% of the text budget', () => {
    expect(stickyCounterVisible(10)).toBe(false)
    expect(stickyCounterVisible(STICKY_TEXT_MAX * 0.9)).toBe(true)
    expect(stickyCounterVisible(STICKY_TEXT_MAX)).toBe(true)
  })
})
