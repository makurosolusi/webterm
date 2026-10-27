import { describe, it, expect } from 'vitest'
import { toFlow, toWsNode, addNode, removeNode, groupByStatus, workspaceNameFromPath } from './store'
import type { AgentStatus, WsNode } from '../shared/workspace'

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

  it('round-trips sessionId on an agent node', () => {
    const n: WsNode = { id: 'c', kind: 'agent', x: 0, y: 0, agentId: 'claude', sessionId: 'uuid-1' }
    expect(toWsNode(toFlow(n)).sessionId).toBe('uuid-1')
  })

  it('applies default size when WsNode has none', () => {
    const f = toFlow({ id: 'd', kind: 'terminal', x: 0, y: 0 })
    expect(f.width).toBe(400)
    expect(f.height).toBe(300)
  })

  it('round-trips an explicit size through toFlow -> toWsNode', () => {
    const n: WsNode = { id: 'e', kind: 'terminal', x: 0, y: 0, width: 640, height: 420 }
    const back = toWsNode(toFlow(n))
    expect(back.width).toBe(640)
    expect(back.height).toBe(420)
  })
})

describe('groupByStatus', () => {
  it('groups agent nodes by live status, omits statusless, falls back on label', () => {
    const nodes = [
      { id: 'aaaaaaaa-1', data: { kind: 'agent', title: 'Alpha' } },
      { id: 'bbbbbbbb-2', data: { kind: 'agent', agentId: 'claude' } },
      { id: 'cccccccc-3', data: { kind: 'agent' } },
      { id: 'dddddddd-4', data: { kind: 'agent', title: 'Dangling' } }, // no status -> omitted
    ]
    const statuses: Record<string, AgentStatus> = {
      'aaaaaaaa-1': 'working', 'bbbbbbbb-2': 'working', 'cccccccc-3': 'done',
    }
    const g = groupByStatus(nodes, statuses)
    expect(g.working.map((c) => c.id)).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2'])
    expect(g.done).toHaveLength(1)
    expect(g.waiting).toHaveLength(0)
    expect(g.blocked).toHaveLength(0)
    // label fallback: title, then agentId, then id.slice(0, 8)
    expect(g.working[0].label).toBe('Alpha')
    expect(g.working[1].label).toBe('claude')
    expect(g.done[0].label).toBe('cccccccc')
  })
})

describe('workspaceNameFromPath', () => {
  it('takes the last path segment', () => {
    expect(workspaceNameFromPath('/Users/bip/Documents/myproj')).toBe('myproj')
  })
  it('ignores a trailing slash', () => {
    expect(workspaceNameFromPath('/Users/bip/proj/')).toBe('proj')
  })
  it('falls back to "project" for root or empty', () => {
    expect(workspaceNameFromPath('/')).toBe('project')
    expect(workspaceNameFromPath('')).toBe('project')
  })
})
