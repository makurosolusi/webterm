import { describe, expect, it } from 'vitest'
import { NODE_NAMES, NODE_NAME_MAX, withNodeNames } from './nodeNames'

const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `node-${i}` }))

describe('NODE_NAMES', () => {
  it('is a sizeable pool of capitalized single words without case-duplicates', () => {
    expect(NODE_NAMES.length).toBeGreaterThanOrEqual(200)
    expect(NODE_NAMES.length).toBeLessThanOrEqual(260)
    for (const n of NODE_NAMES) expect(n).toMatch(/^[A-Z][a-z]+$/)
    expect(new Set(NODE_NAMES.map((n) => n.toLowerCase())).size).toBe(NODE_NAMES.length)
  })
})

describe('withNodeNames', () => {
  it('is deterministic: same input, same names', () => {
    const a = withNodeNames(nodes(50)).map((n) => n.name)
    const b = withNodeNames(nodes(50)).map((n) => n.name)
    expect(a).toEqual(b)
    expect(a.every((n) => typeof n === 'string' && NODE_NAMES.includes(n))).toBe(true)
  })

  it('gives 300 nodes unique names, falling back to numbered tier 2', () => {
    const named = withNodeNames(nodes(300)).map((n) => n.name)
    expect(new Set(named.map((n) => n.toLowerCase())).size).toBe(300)
    expect(named.filter((n) => / 2$/.test(n))).toHaveLength(300 - NODE_NAMES.length)
  })

  it('keeps existing names and does not let a new node steal a later node\'s name', () => {
    const first = withNodeNames([{ id: 'a' }])[0].name
    const out = withNodeNames([{ id: 'a' }, { id: 'b', name: first }])
    expect(out[1].name).toBe(first)
    expect(out[0].name).not.toBe(first)
  })

  it('earlier node wins a case-insensitive clash; the later one is renamed', () => {
    const out = withNodeNames([{ id: 'a', name: 'Mango' }, { id: 'b', name: 'mango' }])
    expect(out[0].name).toBe('Mango')
    expect(out[1].name).not.toMatch(/^mango$/i)
    expect(NODE_NAMES).toContain(out[1].name)
  })

  it('preserves identity of unchanged nodes and returns a new array', () => {
    const input = [{ id: 'a', name: 'Otter' }, { id: 'b' }, { id: 'c', name: ' Fern ' }]
    const out = withNodeNames(input)
    expect(out).not.toBe(input)
    expect(out[0]).toBe(input[0])
    expect(out[1]).not.toBe(input[1])
    expect(out[2]).toEqual({ id: 'c', name: 'Fern' })
    const again = withNodeNames(out)
    again.forEach((n, i) => expect(n).toBe(out[i]))
  })

  it('replaces blank and over-long names', () => {
    const out = withNodeNames([{ id: 'a', name: '  ' }, { id: 'b', name: 'x'.repeat(NODE_NAME_MAX + 1) }])
    for (const n of out) expect(NODE_NAMES).toContain(n.name)
  })
})
