import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNode, CanvasUpdateInput } from '../../../canvas/canvasPush'
import type { BridgeLink } from '../../../../shared/workspace'
import { OPEN_GAP } from '../../../../shared/canvasPlace'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { createCanvasEditDefs, type EditCanvas } from './canvas.edit.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board of project p1 (workspace w-p1, seeded by seedPortfolio).
const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, width: 400, height: 300, name: 'Mango', title: 'shell' },
  { id: 'n2', kind: 'browser', x: 1000, y: 500, width: 640, height: 400, name: 'Kiwi' },
  { id: 'a1', kind: 'agent', x: 100, y: 900, agentId: 'claude', name: 'Pear' },
  { id: 'a2', kind: 'agent', x: 600, y: 900, agentId: 'claude', name: 'Plum', collapsed: true },
  { id: 'e1', kind: 'editor', x: 0, y: 2000, width: 660, height: 460, name: 'Lime', filePath: '/srv/alpha/a.ts' },
]
const BRIDGES: BridgeLink[] = [{ id: 'bridge-a1-n2', source: 'a1', target: 'n2', kind: 'context' }]

let f: Fixture
let unregister = (): void => undefined
let updates: CanvasUpdateInput[]
const fake: EditCanvas = {
  update: (input) => { updates.push(input); return { ok: true, updatedAt: 2, nodes: [], bridges: input.bridgesAdd ?? [], unlinked: input.bridgesRemove ?? [] } },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); updates = []
  const ws = { id: 'w-p1', name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD, bridges: BRIDGES } as WorkspaceRecord
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? ws : null))
})
afterEach(() => { unregister(); f.close() })

function ctx(env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasEditDefs({ canvas: () => fake }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R1', conversationId: 'central:global', now: () => 1, env }
}
const edit = (ops: unknown[], c = ctx()) => execTool(c, 'canvas.edit', { projectId: 'p1', ops })
const patchOf = (id: string) => updates[0].patches.find((p) => p.id === id)

describe('canvas.edit', () => {
  it('is R1 behind the read-tools flag', async () => {
    const [def] = createCanvasEditDefs({ canvas: () => fake })
    expect([def.name, def.tier, def.flag]).toEqual(['canvas.edit', 'R1', READ_TOOLS_FLAG])
    expect(await edit([{ op: 'move', node: 'n1', x: 1, y: 1 }], ctx({}))).toMatchObject({ ok: false, code: 'flag_off' })
  })

  it('rejects malformed input before touching the board', async () => {
    const bad: unknown[][] = [
      [], Array.from({ length: 51 }, () => ({ op: 'move', node: 'n1', x: 0, y: 0 })),
      [{ op: 'move', node: 'n1', x: Number.NaN, y: 0 }], [{ op: 'move', node: 'n1', x: 2e6, y: 0 }], [{ op: 'move', node: 'n1', x: 1 }],
      [{ op: 'move', node: 'n1', beside: 'n2', side: 'up' }], [{ op: 'fly', node: 'n1' }], [{ op: 'move', node: 'n1', x: 0, y: 0, extra: 1 }],
      [{ op: 'resize', node: 'n1' }], [{ op: 'resize', node: 'n1', width: -5 }], [{ op: 'set', node: 'n1' }],
      [{ op: 'set', node: 'n1', title: 'x'.repeat(81) }], [{ op: 'set', node: 'n1', title: 'bell\x07' }], [{ op: 'set', node: 'n1', color: 'red' }],
      [{ op: 'arrange', nodes: [], layout: 'grid' }], [{ op: 'arrange', nodes: 'all', layout: 'circle' }],
      [{ op: 'link', from: 'n1' }], [{ op: 'unlink', cable: 'a b' }], ['move'],
    ]
    for (const ops of bad) expect(await edit(ops)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(ctx(), 'canvas.edit', { projectId: 'p1', ops: [{ op: 'move', node: 'n1', x: 0, y: 0 }], extra: 1 })).toMatchObject({ code: 'invalid_shape' })
    expect(updates).toEqual([])
  })

  it('refuses the whole call when any ref is unknown, naming the unknown ones', async () => {
    const res = await edit([{ op: 'move', node: 'n1', x: 5, y: 5 }, { op: 'link', from: 'Ghost', to: 'a1' }, { op: 'move', node: 'n2', beside: 'gone' }])
    expect(res).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['Ghost', 'gone'] } })
    expect(updates).toEqual([])
  })

  it('moves to absolute coords and beside another node on each side, by id or any-case name', async () => {
    const res = await edit([
      { op: 'move', node: 'mango', x: -50, y: 75 },
      { op: 'move', node: 'n2', beside: 'Mango' },
      { op: 'move', node: 'a1', beside: 'n1', side: 'below' },
      { op: 'move', node: 'e1', beside: 'n1', side: 'left' },
      { op: 'move', node: 'a2', beside: 'n1', side: 'above' },
    ])
    expect(res).toMatchObject({ ok: true })
    expect(updates).toHaveLength(1)
    expect(patchOf('n1')).toEqual({ id: 'n1', x: -50, y: 75 })
    expect(patchOf('n2')).toEqual({ id: 'n2', x: -50 + 400 + OPEN_GAP, y: 75 })
    expect(patchOf('a1')).toEqual({ id: 'a1', x: -50, y: 75 + 300 + OPEN_GAP })
    expect(patchOf('e1')).toEqual({ id: 'e1', x: -50 - 660 - OPEN_GAP, y: 75 })
    expect(patchOf('a2')).toEqual({ id: 'a2', x: -50, y: 75 - 300 - OPEN_GAP }) // unsized node = client default 400x300
    expect(await edit([{ op: 'move', node: 'n1', beside: 'Mango' }])).toMatchObject({ ok: false, code: 'same_node' })
  })

  it('applies ops in order: a later op sees an earlier one', async () => {
    await edit([{ op: 'resize', node: 'n1', width: 800 }, { op: 'move', node: 'n2', beside: 'n1' }])
    expect(patchOf('n2')).toMatchObject({ x: 800 + OPEN_GAP, y: 0 })
  })

  it('clamps resize to the node minimum and the max side, and reports it', async () => {
    const res = await edit([{ op: 'resize', node: 'n1', width: 100, height: 9000 }, { op: 'resize', node: 'e1', width: 500 }])
    expect(patchOf('n1')).toEqual({ id: 'n1', width: 240, height: 4000 })
    expect(patchOf('e1')).toEqual({ id: 'e1', width: 500 })
    expect(res.data?.clamped).toEqual([{ id: 'n1', field: 'width', asked: 100, used: 240 }, { id: 'n1', field: 'height', asked: 9000, used: 4000 }])
  })

  it('refuses to resize a collapsed node until an earlier op expands it', async () => {
    expect(await edit([{ op: 'resize', node: 'Plum', width: 500 }])).toMatchObject({ ok: false, code: 'node_collapsed' })
    expect(updates).toEqual([])
    await edit([{ op: 'set', node: 'Plum', collapsed: false }, { op: 'resize', node: 'Plum', width: 500 }])
    expect(patchOf('a2')).toEqual({ id: 'a2', collapsed: false, width: 500 })
  })

  it('arranges listed nodes from their bounding box top-left, or all nodes', async () => {
    await edit([{ op: 'arrange', nodes: ['n2', 'n1', 'n2'], layout: 'row' }])
    expect(patchOf('n2')).toEqual({ id: 'n2', x: 0, y: 0 })
    expect(patchOf('n1')).toEqual({ id: 'n1', x: 640 + OPEN_GAP }) // y already 0: not patched
    updates = []
    await edit([{ op: 'arrange', nodes: 'all', layout: 'grid' }])
    // 5 nodes -> 3 columns [n1 n2 a1] / [a2 e1]; col widths 400, 660, 400; row heights 400, 460.
    expect(patchOf('n1')).toBeUndefined() // already at the origin (0,0)
    expect(patchOf('n2')).toEqual({ id: 'n2', x: 400 + OPEN_GAP, y: 0 })
    expect(patchOf('a1')).toEqual({ id: 'a1', x: 1060 + 2 * OPEN_GAP, y: 0 })
    expect(patchOf('a2')).toEqual({ id: 'a2', x: 0, y: 400 + OPEN_GAP })
    expect(patchOf('e1')).toEqual({ id: 'e1', x: 400 + OPEN_GAP, y: 400 + OPEN_GAP })
  })

  it('sets title/color/collapsed/hideLinks, null clears, and refuses fields the node UI lacks', async () => {
    const res = await edit([
      { op: 'set', node: 'n1', title: '  build  ', color: '#0A84FF', collapsed: true },
      { op: 'set', node: 'a1', hideLinks: true, color: null },
      { op: 'set', node: 'n1', title: null },
    ])
    expect(patchOf('n1')).toEqual({ id: 'n1', title: null, color: '#0a84ff', collapsed: true })
    expect(patchOf('a1')).toEqual({ id: 'a1', hideLinks: true }) // color was already unset: no change
    expect(res.data?.changed).toContainEqual({ id: 'a1', name: 'Pear', fields: ['hideLinks'] })
    updates = []
    expect(await edit([{ op: 'set', node: 'e1', collapsed: true }])).toMatchObject({ ok: false, code: 'field_not_supported', data: { field: 'collapsed' } })
    expect(await edit([{ op: 'set', node: 'n1', hideLinks: true }])).toMatchObject({ ok: false, code: 'field_not_supported', data: { field: 'hideLinks' } })
    expect(updates).toEqual([])
  })

  it('links the pairs the UI allows with a hand-drawn cable id, keeps duplicates, refuses the rest', async () => {
    const res = await edit([{ op: 'link', from: 'Pear', to: 'Plum' }, { op: 'link', from: 'n2', to: 'a1' }])
    expect(updates[0].bridgesAdd).toEqual([{ id: 'bridge-a1-a2', source: 'a1', target: 'a2', kind: 'context' }])
    expect(res.data).toMatchObject({ linked: [{ cable: 'bridge-a1-a2', from: 'Pear', to: 'Plum' }], unlinked: [], wired: [['a1', 'a2']], count: 1 })
    updates = []
    for (const [from, to] of [['n1', 'a1'], ['n2', 'n1'], ['e1', 'a1'], ['a1', 'a1']]) {
      expect(await edit([{ op: 'link', from, to }])).toMatchObject({ ok: false, code: 'link_not_allowed', data: { hint: expect.any(String) } })
    }
    expect(updates).toEqual([])
  })

  it('unlinks by pair in either direction or by cable id; nothing to cut is link_not_found', async () => {
    const res = await edit([{ op: 'unlink', from: 'n2', to: 'a1' }])
    expect(updates[0].bridgesRemove).toEqual(['bridge-a1-n2'])
    expect(res.data?.unlinked).toEqual([{ cable: 'bridge-a1-n2', from: 'Pear', to: 'Kiwi' }])
    updates = []
    await edit([{ op: 'unlink', cable: 'bridge-a1-n2' }])
    expect(updates[0].bridgesRemove).toEqual(['bridge-a1-n2'])
    updates = []
    expect(await edit([{ op: 'unlink', from: 'n1', to: 'a1' }])).toMatchObject({ ok: false, code: 'link_not_found' })
    expect(await edit([{ op: 'unlink', cable: 'bridge-x-y' }])).toMatchObject({ ok: false, code: 'link_not_found' })
    // Cut then redraw the same cable in one call: nothing changes.
    await edit([{ op: 'unlink', cable: 'bridge-a1-n2' }, { op: 'link', from: 'a1', to: 'n2' }])
    expect(updates[0]).toMatchObject({ patches: [], bridgesAdd: [], bridgesRemove: [] })
  })

  it('is all-or-nothing: one refused op after good ones writes nothing', async () => {
    expect(await edit([{ op: 'move', node: 'n1', x: 9, y: 9 }, { op: 'link', from: 'n1', to: 'e1' }])).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(updates).toEqual([])
  })

  it('reports update failures and audits only count and ids', async () => {
    const failing: EditCanvas = { update: () => ({ ok: false, code: 'node_not_found' }) }
    const registry = createRegistry()
    createCanvasEditDefs({ canvas: () => failing }).forEach((d) => registry.register(d))
    const c = { ...ctx(), registry }
    expect(await edit([{ op: 'move', node: 'n1', x: 1, y: 1 }], c)).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(createCanvasEditDefs({ canvas: () => fake })[0].auditKeys).toEqual(['count', 'ids'])
  })
})
