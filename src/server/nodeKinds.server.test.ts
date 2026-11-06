// Server half of the node-kind completeness check (client half: src/client/nodeKinds.registry.test.tsx).
// The Record below is exhaustive by type, so a new WsNodeKind fails tsc here until it is classified.
import { describe, expect, it } from 'vitest'
import type { Workspace, WsNodeKind } from '../shared/workspace'
import { TEMPLATE_KINDS } from './templates/template.model'
import { renderCard } from './awareness/awarenessCard'

const KINDS: Record<WsNodeKind, true> = { terminal: true, agent: true, agentChat: true, files: true, editor: true, browser: true, diff: true, plan: true, app: true }
const ALL = Object.keys(KINDS) as WsNodeKind[]

describe('server registries cover every WsNodeKind', () => {
  it('a template may hold every kind but app (placed by an agent MCP view)', () => {
    expect(ALL.filter((k) => !TEMPLATE_KINDS.includes(k) && k !== 'app')).toEqual([])
  })

  it('the awareness card lists a wired agentChat as a peer', () => {
    const board = {
      id: 'w', name: 'B', cwd: '/proj', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: 'a', kind: 'agent', x: 0, y: 0, agentId: 'claude' }, { id: 'c', kind: 'agentChat', x: 0, y: 0, agentId: 'claude', title: 'Chat' }],
      bridges: [{ id: 'e', source: 'a', target: 'c' }],
    } as unknown as Workspace
    expect(renderCard(board, 'a', () => undefined).text).toMatch(/Wired peers.*"Chat" \(id c, claude\)/s)
  })
})
