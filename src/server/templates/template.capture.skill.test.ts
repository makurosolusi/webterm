import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import { captureTemplate } from './template.capture'

describe('capturing a board that holds a skill node', () => {
  it('leaves the skill node and its cable out (a reference to a library skill is not portable) and keeps the rest', () => {
    const ws: Workspace = {
      id: 'w', name: 'B', cwd: '/proj', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 1,
      nodes: [
        { id: 'a1', kind: 'agent', x: 0, y: 0, agentId: 'claude', cmd: 'claude' },
        { id: 's1', kind: 'skill', x: 0, y: 400, skill: 'webterm-release' },
        { id: 't1', kind: 'terminal', x: 500, y: 0 },
      ],
      bridges: [{ id: 'b1', source: 's1', target: 'a1', kind: 'skill' }],
    }
    const t = captureTemplate({ ws, id: 'tpl', name: 'Board', routines: [] })
    expect(t.nodes.map((n) => n.kind)).toEqual(['agent', 'terminal'])
    expect(t.cables).toEqual([])
  })
})
