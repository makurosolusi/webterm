import { describe, expect, it } from 'vitest'
import { lineDiff } from './ca2Routes.diff'

describe('lineDiff', () => {
  it('marks removed, added and unchanged lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toBe('  a\n+ B\n- b\n  c')
  })
  it('is all additions when there is no previous version', () => {
    expect(lineDiff('', 'x\ny')).toBe('+ x\n+ y')
  })
  it('is all removals when the new text is empty and unchanged text has no markers', () => {
    expect(lineDiff('x', '')).toBe('- x')
    expect(lineDiff('same', 'same')).toBe('  same')
  })
  it('degrades to all-added past the size cap instead of building a huge table', () => {
    const big = Array.from({ length: 401 }, (_, i) => `l${i}`).join('\n')
    const out = lineDiff('l0', big).split('\n')
    expect(out).toHaveLength(401)
    expect(out.every((l) => l.startsWith('+ '))).toBe(true)
  })
})
