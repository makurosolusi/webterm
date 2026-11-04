import { describe, it, expect } from 'vitest'
import { Position } from '@xyflow/react'
import { borderExit, floatingEdgeParams, canLink, bridgeExists, hiddenEdgeNodeIds, edgeVisible } from './floatingEdge'
import type { Rect } from './floatingEdge'

const r = (x: number, y: number, width = 100, height = 60): Rect => ({ x, y, width, height })

describe('borderExit', () => {
  it('exits Right at vertical center when target is to the right', () => {
    const e = borderExit(r(0, 0), r(500, 0))
    expect(e.position).toBe(Position.Right)
    expect(e.x).toBe(100)       // from.x + width
    expect(e.y).toBe(30)        // from.y + height/2
  })
  it('exits Left when target is to the left', () => {
    const e = borderExit(r(500, 0), r(0, 0))
    expect(e.position).toBe(Position.Left)
    expect(e.x).toBe(500)       // from.x + 0
    expect(e.y).toBe(30)
  })
})

describe('floatingEdgeParams', () => {
  it('returns both endpoints', () => {
    const p = floatingEdgeParams(r(0, 0), r(500, 100))
    expect(p.sourcePosition).toBe(Position.Right)
    expect(p.targetPosition).toBe(Position.Left)
    expect(p.sx).toBe(100)
    expect(p.tx).toBe(500)
    expect(p.sy).toBe(30)
    expect(p.ty).toBe(130)
  })
})

describe('canLink', () => {
  const ag = (id: string, agentId = 'claude') => ({ id, kind: 'agent', agentId })
  const br = (id: string) => ({ id, kind: 'browser' })
  it('true for two claude ids on distinct nodes', () => {
    expect(canLink(ag('a'), ag('b'))).toBe(true)
  })
  it('false for claude ↔ undefined (terminal)', () => {
    expect(canLink(ag('a'), { id: 'b', kind: 'terminal' })).toBe(false)
  })
  it('false for source === target', () => {
    expect(canLink(ag('a'), ag('a', 'codex'))).toBe(false)
  })
  it('agent ↔ browser true in both directions', () => {
    expect(canLink(ag('a'), br('b'))).toBe(true)
    expect(canLink(br('b'), ag('a'))).toBe(true)
  })
  it('browser ↔ browser and browser ↔ plain terminal false', () => {
    expect(canLink(br('a'), br('b'))).toBe(false)
    expect(canLink(br('a'), { id: 'b', kind: 'terminal' })).toBe(false)
  })
  it('agent ↔ diff true both ways; diff ↔ diff, diff ↔ browser, diff ↔ terminal false', () => {
    const df = (id: string) => ({ id, kind: 'diff' })
    expect(canLink(ag('a'), df('d'))).toBe(true)
    expect(canLink(df('d'), ag('a'))).toBe(true)
    expect(canLink(df('d'), df('e'))).toBe(false)
    expect(canLink(df('d'), br('b'))).toBe(false)
    expect(canLink(df('d'), { id: 't', kind: 'terminal' })).toBe(false)
  })
})

describe('bridgeExists', () => {
  it('true in both orderings', () => {
    const bridges = [{ source: 'a', target: 'b' }]
    expect(bridgeExists(bridges, 'a', 'b')).toBe(true)
    expect(bridgeExists(bridges, 'b', 'a')).toBe(true)
  })
  it('false for an unconnected pair', () => {
    expect(bridgeExists([{ source: 'a', target: 'b' }], 'a', 'c')).toBe(false)
  })
})

describe('hiddenEdgeNodeIds', () => {
  it('collects only hideLinks === true', () => {
    const ids = hiddenEdgeNodeIds([
      { id: 'a', data: { hideLinks: true } },
      { id: 'b', data: { hideLinks: false } },
      { id: 'c', data: {} },
    ])
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(false)
    expect(ids.has('c')).toBe(false)
    expect(ids.size).toBe(1)
  })
})

describe('edgeVisible', () => {
  it('false when either endpoint hidden, true otherwise', () => {
    const hidden = new Set(['a'])
    expect(edgeVisible({ source: 'a', target: 'b' }, hidden)).toBe(false)
    expect(edgeVisible({ source: 'b', target: 'a' }, hidden)).toBe(false)
    expect(edgeVisible({ source: 'b', target: 'c' }, hidden)).toBe(true)
  })
})
