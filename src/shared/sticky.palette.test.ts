import { describe, expect, it } from 'vitest'
import { STICKY_COLORS, STICKY_TAG_MAX, STICKY_TEXT_MAX, cleanStickyTag, cleanStickyText, normalizeStickyColor, stickyInkContrast } from './sticky.palette'
import { normalizeWorkspace } from './workspace.schema'

describe('sticky palette', () => {
  it('has 10 unique ids and valid hex values', () => {
    expect(STICKY_COLORS).toHaveLength(10)
    expect(new Set(STICKY_COLORS.map((c) => c.id)).size).toBe(10)
    for (const c of STICKY_COLORS) expect(c.hex).toMatch(/^#[0-9A-F]{6}$/)
  })
  it.each(STICKY_COLORS.map((c) => [c.id, c.hex]))('ink on %s reaches WCAG AA (4.5:1)', (_id, hex) => {
    expect(stickyInkContrast(hex)).toBeGreaterThanOrEqual(4.5)
  })
  it('computes the real WCAG ratio (ink on white is well above 15)', () => {
    expect(stickyInkContrast('#FFFFFF')).toBeGreaterThan(15)
    expect(stickyInkContrast('#1C1C1C')).toBeCloseTo(1, 5)
  })
  it('falls back to lemon for unknown colors', () => {
    expect(normalizeStickyColor('blue')).toBe('blue')
    expect(normalizeStickyColor('#ff0000')).toBe('lemon')
    expect(normalizeStickyColor(7)).toBe('lemon')
  })
  it('caps text and flattens the tag', () => {
    expect(cleanStickyText('x'.repeat(5000))).toHaveLength(STICKY_TEXT_MAX)
    expect(cleanStickyText('a\nb\u0000')).toBe('a\nb')
    expect(cleanStickyTag('  one\ntwo \r\n three ')).toBe('one two three')
    expect(cleanStickyTag('y'.repeat(99))).toHaveLength(STICKY_TAG_MAX)
  })
})

describe('sticky nodes through normalizeWorkspace', () => {
  const board = (node: Record<string, unknown>) => normalizeWorkspace({ name: 'W', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 's', kind: 'sticky', x: 1, y: 2, width: 180, height: 180, ...node }] })

  it('keeps the kind and round-trips valid fields', () => {
    const r = board({ stickyText: 'hello\nworld', stickyTag: 'todo', stickyColor: 'pink' })
    expect(r.issues).toEqual([])
    expect(r.board.nodes[0]).toMatchObject({ kind: 'sticky', stickyText: 'hello\nworld', stickyTag: 'todo', stickyColor: 'pink', width: 180 })
  })
  it('truncates 5000-char text, flattens a multi-line tag, drops an unknown color', () => {
    const n = board({ stickyText: 'x'.repeat(5000), stickyTag: 'a\nb\nc', stickyColor: 'chartreuse' }).board.nodes[0]
    expect(n.stickyText).toHaveLength(STICKY_TEXT_MAX)
    expect(n.stickyTag).toBe('a b c')
    expect(n.stickyColor).toBeUndefined()
  })
})
