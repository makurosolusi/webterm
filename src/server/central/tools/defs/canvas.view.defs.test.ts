import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '../../../../shared/protocol'
import { registerActiveWorkspace } from '../../context/contextHeader'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { createCanvasViewDefs, type ViewUi } from './canvas.view.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only boards: p1 -> w-p1 (seeded by seedPortfolio), p2 -> w-p2.
const BOARD = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango', title: 'shell' },
  { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi 2' },
  { id: 'n3', kind: 'agent', x: 0, y: 0 },
]
const WORKSPACES: WorkspaceRecord[] = [
  { id: 'w-p1', name: 'Alpha WS', nodes: BOARD },
  { id: 'w-p2', name: 'Beta WS', nodes: Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, kind: 'terminal' })) },
]

let f: Fixture
let active: string | null
let frames: ServerMsg[]
const undo: Array<() => void> = []
const ui: ViewUi = { setActive: (id) => { active = id }, broadcast: (msg) => { frames.push(msg) } }

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); active = null; frames = []
  undo.push(registerWorkspaceLookup((id) => WORKSPACES.find((w) => w.id === id) ?? null))
  undo.push(registerActiveWorkspace(() => active))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close() })

function ctx(maxTier: Tier = 'R1', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasViewDefs({ ui: () => ui }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const show = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.show', input)
const view = (input: Record<string, unknown> = {}, c = ctx()) => execTool(c, 'canvas.view', input)

describe('canvas.view / canvas.show defs', () => {
  it('declares view at R0 and show at R1, both behind the read-tools flag', async () => {
    expect(createCanvasViewDefs({ ui: () => ui }).map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.view', 'R0', READ_TOOLS_FLAG], ['canvas.show', 'R1', READ_TOOLS_FLAG]])
    expect(await show({ projectId: 'p1' }, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await view({}, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(frames).toEqual([])
  })
})

describe('canvas.show', () => {
  it('sets the active workspace and broadcasts the exact view frame', async () => {
    expect(await show({ projectId: 'p1' })).toMatchObject({ ok: true, data: { workspaceId: 'w-p1', name: 'Alpha WS' } })
    expect(active).toBe('w-p1')
    expect(frames).toEqual([{ t: 'view', workspaceId: 'w-p1' }])
  })

  it('resolves a node name (any case) or id to the node id within that workspace', async () => {
    expect(await show({ projectId: 'p1', nodeId: 'kiwi 2' })).toMatchObject({ ok: true, data: { workspaceId: 'w-p1', nodeId: 'n2' } })
    expect(await show({ projectId: 'p1', nodeId: 'n1' })).toMatchObject({ ok: true, data: { nodeId: 'n1' } })
    expect(frames).toEqual([{ t: 'view', workspaceId: 'w-p1', nodeId: 'n2' }, { t: 'view', workspaceId: 'w-p1', nodeId: 'n1' }])
  })

  it('fit: true broadcasts a fit frame; fit with a node or a non-boolean fit is refused', async () => {
    expect(await show({ projectId: 'p1', fit: true })).toMatchObject({ ok: true, data: { workspaceId: 'w-p1', fit: true } })
    expect(await show({ projectId: 'p1', fit: false })).toMatchObject({ ok: true, data: { workspaceId: 'w-p1' } })
    expect(await show({ projectId: 'p1', fit: true, nodeId: 'n1' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await show({ projectId: 'p1', fit: 'yes' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(frames).toEqual([{ t: 'view', workspaceId: 'w-p1', fit: true }, { t: 'view', workspaceId: 'w-p1' }])
  })

  it('rejects an unknown node, project or workspace, and extra keys, without switching', async () => {
    expect(await show({ projectId: 'p1', nodeId: 'ghost' })).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['ghost'] } })
    expect(await show({ projectId: 'nope' })).toMatchObject({ ok: false, code: 'project_not_found' })
    expect(await show({ projectId: 'p3' })).toMatchObject({ ok: false, code: 'workspace_not_found' }) // w-p3 was deleted
    expect(await show({ projectId: 'p1', zoom: 2 })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await show({ projectId: 'p1', nodeId: 'a b' })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(active).toBeNull()
    expect(frames).toEqual([])
  })
})

describe('canvas.view', () => {
  it('lists the nodes of the active workspace with names', async () => {
    active = 'w-p1'
    expect(await view()).toEqual(expect.objectContaining({ ok: true, data: {
      viewing: { projectId: 'p1', name: 'Alpha WS' },
      nodes: [{ id: 'n1', name: 'Mango', kind: 'terminal', title: 'shell' }, { id: 'n2', name: 'Kiwi 2', kind: 'browser' }, { id: 'n3', name: expect.any(String), kind: 'agent' }],
      total: 3,
    } }))
  })

  it('caps the list at 50 and reports the total; null viewing lists nothing; extra keys refused', async () => {
    active = 'w-p2'
    const res = await view()
    expect((res.data?.nodes as unknown[]).length).toBe(50)
    expect(res.data?.total).toBe(60)
    active = null
    expect(await view()).toMatchObject({ ok: true, data: { viewing: null, nodes: [], total: 0 } })
    expect(await view({ x: 1 })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })

  it('follows canvas.show', async () => {
    await show({ projectId: 'p2' })
    expect((await view()).data?.viewing).toEqual({ projectId: 'p2', name: 'Beta WS' })
  })
})
