import { describe, it, expect } from 'vitest'
import { loadNodes, saveNodes, addNode, removeNode } from './store'
import type { TermNode } from './store'

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

describe('store', () => {
  it('round-trips saved nodes', () => {
    const s = fakeStorage()
    const nodes: TermNode[] = [{ id: 'a', x: 1, y: 2 }]
    saveNodes(s, nodes)
    expect(loadNodes(s)).toEqual(nodes)
  })

  it('returns [] on empty storage', () => {
    expect(loadNodes(fakeStorage())).toEqual([])
  })

  it('returns [] on corrupt JSON', () => {
    const s = fakeStorage()
    s.setItem('webterm.nodes', 'not json')
    expect(loadNodes(s)).toEqual([])
  })

  it('addNode is pure', () => {
    const orig: TermNode[] = [{ id: 'a', x: 0, y: 0 }]
    const next = addNode(orig, { id: 'b', x: 1, y: 1 })
    expect(orig).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ id: 'b', x: 1, y: 1 })
  })

  it('removeNode is pure', () => {
    const orig: TermNode[] = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }]
    const next = removeNode(orig, 'a')
    expect(orig).toHaveLength(2)
    expect(next).toEqual([{ id: 'b', x: 1, y: 1 }])
  })
})
