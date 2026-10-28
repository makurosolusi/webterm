import { describe, it, expect } from 'vitest'
import { toFlow, toWsNode, addNode, removeNode, groupByStatus, workspaceNameFromPath, toFlowEdge, toBridge } from './store'
import type { AgentStatus, WsNode, BridgeLink } from '../shared/workspace'
import type { Edge } from '@xyflow/react'

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

  it('round-trips collapsed and comments through toFlow -> toWsNode', () => {
    const n: WsNode = {
      id: 'f', kind: 'agent', x: 0, y: 0, agentId: 'claude',
      collapsed: true, comments: [{ id: 'c1', text: 'note', ts: 123 }],
    }
    const back = toWsNode(toFlow(n))
    expect(back.collapsed).toBe(true)
    expect(back.comments).toEqual([{ id: 'c1', text: 'note', ts: 123 }])
  })

  // Satu-satunya state node files/editor adalah path-nya; kalau serializer menjatuhkannya, node
  // itu kembali setelah reload sebagai panel kosong tanpa folder/file.
  it('round-trips dirPath and filePath through toFlow -> toWsNode', () => {
    const dir = toWsNode(toFlow({ id: 'g', kind: 'files', x: 0, y: 0, dirPath: '/tmp/st/proj' }))
    expect(dir.kind).toBe('files')
    expect(dir.dirPath).toBe('/tmp/st/proj')

    const file = toWsNode(toFlow({ id: 'h', kind: 'editor', x: 0, y: 0, filePath: '/tmp/st/proj/a.md' }))
    expect(file.kind).toBe('editor')
    expect(file.filePath).toBe('/tmp/st/proj/a.md')
  })
})

describe('edge serializer', () => {
  it('toFlowEdge preserves id/source/target and sets context type + kind', () => {
    const b: BridgeLink = { id: 'e1', source: 'a', target: 'b', kind: 'context' }
    const e = toFlowEdge(b)
    expect(e.id).toBe('e1')
    expect(e.source).toBe('a')
    expect(e.target).toBe('b')
    expect(e.type).toBe('context')
    expect(e.data).toEqual({ kind: 'context' })
  })

  it('toBridge recovers id/source/target/kind from an Edge', () => {
    const e: Edge = { id: 'e2', source: 's', target: 't', type: 'context' }
    expect(toBridge(e)).toEqual({ id: 'e2', source: 's', target: 't', kind: 'context' })
  })

  it('round-trips a BridgeLink through toFlowEdge -> toBridge', () => {
    const b: BridgeLink = { id: 'e3', source: 'x', target: 'y', kind: 'context' }
    expect(toBridge(toFlowEdge(b))).toEqual(b)
  })

  // Kabel buka-file harus tetap 'file' setelah reload; kalau jatuh ke 'context' labelnya
  // berubah jadi "⇄ context" — bohong tentang apa yang dibaca agent.
  it('round-trips a file link without turning it into a context link', () => {
    const b: BridgeLink = { id: 'bridge-f1-e1', source: 'f1', target: 'e1', kind: 'file' }
    expect(toBridge(toFlowEdge(b))).toEqual(b)
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
