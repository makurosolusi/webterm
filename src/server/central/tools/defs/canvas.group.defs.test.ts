import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasGroupsResult } from '../../../canvas/canvasPush'
import { applyGroupOp, type GroupOp, type GroupTabs } from '../../../canvas/canvasPush.layout'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { createCanvasGroupDefs, type GroupCanvas } from './canvas.group.defs'
import { READ_TOOLS_FLAG } from './read.shared'

// test-only board: p1 -> w-p1 (seeded by seedPortfolio).
const BOARD = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'n2', kind: 'browser', x: 0, y: 0, name: 'Kiwi 2' },
  { id: 'n3', kind: 'agent', x: 0, y: 0, name: 'Pear' },
]
const WORKSPACES: WorkspaceRecord[] = [{ id: 'w-p1', name: 'Alpha WS', nodes: BOARD }]

let f: Fixture
let tabs: GroupTabs
let calls: Array<{ workspaceId: string; op: GroupOp }>
let nextId: number
const undo: Array<() => void> = []
// A fake CanvasPush.groups running the real layout rules on an in-memory board.
const canvas: GroupCanvas = {
  groups(input): CanvasGroupsResult {
    calls.push(input)
    const res = applyGroupOp(tabs, input.op, `g${nextId++}`)
    if (!res.ok) return res
    tabs = res.tabs
    return { ok: true, updatedAt: 2, groups: tabs.groups, ...(res.groupId ? { groupId: res.groupId } : {}) }
  },
}

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db)
  tabs = { order: ['n1', 'n2', 'n3'], groups: [] }; calls = []; nextId = 1
  undo.push(registerWorkspaceLookup((id) => WORKSPACES.find((w) => w.id === id) ?? null))
})
afterEach(() => { while (undo.length) undo.pop()!(); f.close() })

function ctx(maxTier: Tier = 'R1', env: Record<string, string> = { [READ_TOOLS_FLAG]: 'on' }): ToolCtx {
  const registry = createRegistry()
  createCanvasGroupDefs({ canvas: () => canvas }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:global', now: () => 1, env }
}
const group = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.group', { projectId: 'p1', ...input })

describe('canvas.group', () => {
  it('is R1 behind the read-tools flag', async () => {
    expect(createCanvasGroupDefs({ canvas: () => canvas }).map((d) => [d.name, d.tier, d.flag])).toEqual([['canvas.group', 'R1', READ_TOOLS_FLAG]])
    expect(await group({ op: 'create', nodes: ['n1'] }, ctx('R0'))).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(await group({ op: 'create', nodes: ['n1'] }, ctx('R1', {}))).toMatchObject({ ok: false, code: 'flag_off' })
    expect(calls).toEqual([])
  })

  it('create resolves names (any case) or ids and returns every group', async () => {
    expect(await group({ op: 'create', name: 'Docs', nodes: ['kiwi 2', 'n3'] })).toMatchObject({
      ok: true, data: { groupId: 'g1', groups: [{ id: 'g1', name: 'Docs', collapsed: false, nodes: ['n2', 'n3'] }] },
    })
    expect(calls).toEqual([{ workspaceId: 'w-p1', op: { op: 'create', name: 'Docs', nodeIds: ['n2', 'n3'] } }])
    // no name: the human's default "Group N"; the member leaves Docs
    expect(await group({ op: 'create', nodes: ['Pear'] })).toMatchObject({
      ok: true, data: { groups: [{ id: 'g1', nodes: ['n2'] }, { id: 'g2', name: 'Group 1', nodes: ['n3'] }] },
    })
  })

  it('add, remove, rename, collapse and ungroup by group name or id', async () => {
    await group({ op: 'create', name: 'Docs', nodes: ['n2'] })
    expect(await group({ op: 'add', group: 'docs', nodes: ['Mango'] })).toMatchObject({ ok: true, data: { groupId: 'g1', groups: [{ nodes: ['n2', 'n1'] }] } })
    expect(await group({ op: 'remove', group: 'g1', nodes: ['n2'] })).toMatchObject({ ok: true, data: { groups: [{ nodes: ['n1'] }] } })
    expect(await group({ op: 'rename', group: 'Docs', name: 'Web' })).toMatchObject({ ok: true, data: { groups: [{ name: 'Web' }] } })
    expect(await group({ op: 'collapse', group: 'web', collapsed: true })).toMatchObject({ ok: true, data: { groups: [{ collapsed: true }] } })
    expect(await group({ op: 'ungroup', group: 'Web' })).toEqual(expect.objectContaining({ ok: true, data: { groups: [] } }))
    expect(tabs.order.sort()).toEqual(['n1', 'n2', 'n3']) // ungroup keeps the nodes
  })

  it('refuses unknown nodes before writing, and passes group refusals through', async () => {
    expect(await group({ op: 'create', nodes: ['n1', 'ghost'] })).toMatchObject({ ok: false, code: 'node_not_found', data: { unknown: ['ghost'] } })
    expect(calls).toEqual([])
    expect(await group({ op: 'rename', group: 'Nope', name: 'X' })).toMatchObject({ ok: false, code: 'group_not_found', data: { group: 'Nope' } })
    await group({ op: 'create', name: 'Docs', nodes: ['n1'] })
    expect(await group({ op: 'remove', group: 'Docs', nodes: ['n2'] })).toMatchObject({ ok: false, code: 'node_not_in_group' })
    expect(await group({ op: 'create', nodes: ['n1'], projectId: 'nope' })).toMatchObject({ ok: false, code: 'project_not_found' })
  })

  it('refuses a bad shape per op', async () => {
    const bad: Array<Record<string, unknown>> = [
      { op: 'explode' },
      { op: 'create' }, // nodes required
      { op: 'create', nodes: [] },
      { op: 'create', nodes: Array.from({ length: 51 }, (_, i) => `n${i}`) },
      { op: 'create', nodes: ['a b'] },
      { op: 'create', nodes: ['n1'], name: '  ' },
      { op: 'create', nodes: ['n1'], group: 'g1' }, // key of another op
      { op: 'add', nodes: ['n1'] }, // group required
      { op: 'rename', group: 'g1' }, // name required
      { op: 'rename', group: 'g1', name: 'x\u0007' },
      { op: 'ungroup', group: '' },
      { op: 'collapse', group: 'g1', collapsed: 'yes' },
      { op: 'ungroup', group: 'g1', zoom: 2 },
    ]
    for (const input of bad) expect(await group(input), JSON.stringify(input)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(calls).toEqual([])
  })
})
