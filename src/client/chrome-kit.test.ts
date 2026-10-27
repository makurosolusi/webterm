import { describe, it, expect } from 'vitest'
import { contextFillColor, USAGE_RED, USAGE_YELLOW, USAGE_GREEN } from './UsagePill'
import { NODE_COLORS } from './NodeColorSwatch'

describe('contextFillColor', () => {
  it('> 85 → red', () => { expect(contextFillColor(90)).toBe(USAGE_RED) })
  it('86 is red (strictly greater than 85)', () => { expect(contextFillColor(86)).toBe(USAGE_RED) })
  it('85 is NOT red → yellow (>=60 band)', () => { expect(contextFillColor(85)).toBe(USAGE_YELLOW) })
  it('60 boundary → yellow', () => { expect(contextFillColor(60)).toBe(USAGE_YELLOW) })
  it('59 → green', () => { expect(contextFillColor(59)).toBe(USAGE_GREEN) })
  it('0 → green', () => { expect(contextFillColor(0)).toBe(USAGE_GREEN) })
})
describe('NODE_COLORS', () => {
  it('is a non-empty palette of hex strings', () => {
    expect(NODE_COLORS.length).toBeGreaterThan(0)
    for (const c of NODE_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
