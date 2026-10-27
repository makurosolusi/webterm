import { describe, it, expect } from 'vitest'
import { toFlow, toWsNode, addNode, removeNode } from './store'
import type { WsNode } from '../shared/workspace'

describe('store serializer', () => {
  it('round-trips a terminal node (kind, cwd)', () => {
    const n: WsNode = { id: 'a', kind: 'terminal', x: 1, y: 2, cwd: '/work' }
    const back = toWsNode(toFlow(n))
    expect(back.kind).toBe('terminal')
    expect(back.cwd).toBe('/work')
    expect(back.cmd).toBeUndefined()
    expect(back.agentId).toBeUndefined()
    expect({ x: back.x, y: back.y }).toEqual({ x: 1, y: 2 })
  })

  it('round-trips an agent node (kind, cmd, cwd, agentId)', () => {
    const n: WsNode = { id: 'b', kind: 'agent', x: 5, y: 6, cmd: 'envman -e p -- claude', cwd: '/w', agentId: 'claude', color: '#d97757' }
    const back = toWsNode(toFlow(n))
    expect(back.kind).toBe('agent')
    expect(back.cmd).toBe('envman -e p -- claude')
    expect(back.cwd).toBe('/w')
    expect(back.agentId).toBe('claude')
  })

  it('toFlow maps kind to type', () => {
    expect(toFlow({ id: 'x', kind: 'agent', x: 0, y: 0 }).type).toBe('agent')
  })

  it('addNode is pure', () => {
    const orig: WsNode[] = [{ id: 'a', kind: 'terminal', x: 0, y: 0 }]
    const next = addNode(orig, { id: 'b', kind: 'terminal', x: 1, y: 1 })
    expect(orig).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next[1].id).toBe('b')
  })

  it('removeNode is pure', () => {
    const orig: WsNode[] = [{ id: 'a', kind: 'terminal', x: 0, y: 0 }, { id: 'b', kind: 'terminal', x: 1, y: 1 }]
    const next = removeNode(orig, 'a')
    expect(orig).toHaveLength(2)
    expect(next.map((n) => n.id)).toEqual(['b'])
  })
})
