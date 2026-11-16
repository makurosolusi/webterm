import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasAddInput, CanvasNode } from '../../../canvas/canvasPush'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, GuardRequest, ToolCtx } from '../toolTypes'
import { createCanvasActDefs, type NodeCanvas } from './canvas.act.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'c-ag1', kind: 'agent', x: 0, y: 0, agentId: 'claude', name: 'Kiwi' },
]
let f: Fixture
let unregister = (): void => undefined
let adds: CanvasAddInput[]
const fake: NodeCanvas = {
  add: (input) => { adds.push(input); return { ok: true, updatedAt: 2, nodes: input.nodes } },
  remove: () => ({ ok: false, code: 'node_not_found' }),
}
beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); adds = []
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { id, name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD } : null))
})
afterEach(() => { unregister(); f.close() })

function ctx(canvas: NodeCanvas = fake, guard: ControlGuard = ALLOW_ALL_GUARD): ToolCtx {
  const registry = createRegistry()
  createCanvasActDefs({ canvas: () => canvas, browserOn: () => true }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
const open = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.open', { projectId: 'p1', ...input })

describe('canvas.open connectTo', () => {
  it('opens a Claude node and cables it in the same add call (connectTo -> new by default)', async () => {
    expect(await open({ kind: 'claude', connectTo: 'Kiwi' })).toMatchObject({ ok: true, data: { count: 1 } })
    const id = adds[0]!.nodes[0]!.id
    expect(adds[0]!.anchorNodeId).toBe('c-ag1')
    expect(adds[0]!.bridges).toEqual([{ id: `bridge-c-ag1-${id}`, source: 'c-ag1', target: id, kind: 'context' }])
  })

  it('direction "from" reverses the cable, ids work as refs, count>1 cables each node', async () => {
    expect(await open({ kind: 'claude', count: 2, connectTo: 'c-ag1', direction: 'from' })).toMatchObject({ ok: true, data: { count: 2 } })
    const [a, b] = adds[0]!.nodes
    expect(adds[0]!.bridges).toEqual([
      { id: `bridge-${a!.id}-c-ag1`, source: a!.id, target: 'c-ag1', kind: 'context' },
      { id: `bridge-${b!.id}-c-ag1`, source: b!.id, target: 'c-ag1', kind: 'context' },
    ])
  })

  it('an unknown ref (or a node of another project) opens nothing', async () => {
    expect(await open({ kind: 'claude', connectTo: 'Otter' })).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['Otter'] } })
    expect(await open({ kind: 'claude', connectTo: 'n-of-project-2' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(adds).toEqual([])
  })

  it('a refused link (terminal target or unlinkable kind) leaves no node behind', async () => {
    expect(await open({ kind: 'claude', connectTo: 'Mango' })).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(await open({ kind: 'terminal', connectTo: 'Kiwi' })).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(adds).toEqual([])
  })

  it('a failing open reports its code (no cable result) and a malformed direction is rejected', async () => {
    const c = ctx({ ...fake, add: (i) => { adds.push(i); return { ok: false, code: 'workspace_not_found' } } })
    expect(await open({ kind: 'claude', connectTo: 'Kiwi' }, c)).toMatchObject({ ok: false, code: 'workspace_not_found' })
    adds = []
    expect(await open({ kind: 'claude', connectTo: 'Kiwi', direction: 'sideways' }, c)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await open({ kind: 'claude', direction: 'to' }, c)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(adds).toEqual([])
  })

  it('still goes through the guard: a denying guard blocks the open and the cable', async () => {
    const seen: GuardRequest[] = []
    const deny: ControlGuard = { check: (r) => { seen.push(r); return { ok: false, code: 'denied' } } }
    const res = await open({ kind: 'claude', connectTo: 'Kiwi' }, ctx(fake, deny))
    expect(res.ok).toBe(false)
    expect(seen[0]).toMatchObject({ tool: 'canvas.open', input: { connectTo: 'Kiwi' } })
    expect(adds).toEqual([])
  })
})
