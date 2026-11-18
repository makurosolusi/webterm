import { describe, expect, it } from 'vitest'
import { describeLayout, layoutFromSpec, parseLayoutSpec } from './browser.layoutSpec'
import { layoutTabIds, validLayout } from './browser.layout'

describe('parseLayoutSpec', () => {
  it('reads each shape with existing and new tabs', () => {
    expect(parseLayoutSpec('single t1')).toEqual({ ok: true, mode: 'single', leaves: [{ tab: 't1' }] })
    expect(parseLayoutSpec('h t1 new:https://b.test/x')).toEqual({ ok: true, mode: 'h', leaves: [{ tab: 't1' }, { url: 'https://b.test/x' }] })
    expect(parseLayoutSpec('  grid a b c d ')).toMatchObject({ ok: true, mode: 'grid' })
  })
  it.each([
    ['', /unknown shape/], ['zig t1 t2', /unknown shape/], ['single', /exactly 1/], ['single a b', /exactly 1/], ['h a', /2 to 4/],
    ['v a b c d e', /2 to 4/], ['grid a b c', /exactly 4/], ['h a a', /twice/], ['h a b;rm', /not a tab id/], ['h a new:', /needs an http/],
    ['h a new:javascript:alert(1)', /needs an http/], ['h a new:about:blank', /needs an http/],
  ])('refuses %j', (spec, why) => {
    const r = parseLayoutSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toMatch(why)
  })
  it('refuses non-text', () => { expect(parseLayoutSpec(undefined).ok).toBe(false) })
})

describe('layoutFromSpec', () => {
  it('single stores nothing', () => { expect(layoutFromSpec('single', ['a'])).toBeNull() })
  it('h and v keep order and give every pane an equal share', () => {
    const l = layoutFromSpec('h', ['a', 'b', 'c'])
    expect(l && layoutTabIds(l)).toEqual(['a', 'b', 'c'])
    expect(describeLayout(l!)).toBe('h(a, h(b, c))')
    expect(l).toMatchObject({ ratio: 1 / 3, b: { ratio: 0.5 } })
    expect(describeLayout(layoutFromSpec('v', ['a', 'b'])!)).toBe('v(a, b)')
  })
  it('every built layout passes the shared validator (depth, limit, ids)', () => {
    for (const [mode, ids] of [['h', ['a', 'b', 'c', 'd']], ['v', ['a', 'b', 'c', 'd']], ['grid', ['a', 'b', 'c', 'd']]] as const) {
      const l = layoutFromSpec(mode, ids)!
      expect(validLayout(l)).toEqual(l)
    }
    expect(describeLayout(layoutFromSpec('grid', ['a', 'b', 'c', 'd'])!)).toBe('v(h(a, b), h(c, d))')
  })
})
