// Central parity for canvas skill nodes: canvas.open kind "skill" (+ connectTo) and canvas.edit link/unlink of a
// skill node and an agent, through the shared typed-port rule (docs/decisions/skill-canvas-nodes.md).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasAddInput, CanvasNode, CanvasUpdateInput } from '../../../canvas/canvasPush'
import type { BridgeLink } from '../../../../shared/workspace'
import { MAX_ATTACHED_SKILLS, SKILL_NODE_SIZE } from '../../../../shared/skillPorts'
import type { SkillLookup } from '../../../skillAttach'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { createCanvasActDefs, type NodeCanvas } from './canvas.act.defs'
import { createCanvasEditDefs, type EditCanvas } from './canvas.edit.defs'
import { READ_TOOLS_FLAG } from './read.shared'

const BOARD: CanvasNode[] = [
  { id: 'n1', kind: 'terminal', x: 0, y: 0, name: 'Mango' },
  { id: 'a1', kind: 'agent', x: 0, y: 0, agentId: 'claude', name: 'Kiwi' },
  { id: 'a2', kind: 'agent', x: 0, y: 0, agentId: 'codex', name: 'Pear' },
  { id: 'c1', kind: 'agentChat', x: 0, y: 0, agentId: 'claude', name: 'Plum' },
  { id: 'sk1', kind: 'skill', x: 0, y: 0, name: 'Lime', skill: 'webterm-release' },
]
let bridges: BridgeLink[]
let f: Fixture
let unregister = (): void => undefined
let adds: CanvasAddInput[]
let updates: CanvasUpdateInput[]
const canvas: NodeCanvas & EditCanvas = {
  add: (input) => { adds.push(input); return { ok: true, updatedAt: 2, nodes: input.nodes } },
  remove: () => ({ ok: false, code: 'node_not_found' }),
  update: (input) => { updates.push(input); return { ok: true, updatedAt: 2, nodes: [], bridges: input.bridgesAdd ?? [], unlinked: input.bridgesRemove ?? [] } },
}
const row = (name: string, o: Record<string, unknown> = {}) => ({ name, version: '3', audience: 'canvas', ...o })
/** Library: an active canvas skill, a switched-off one, and a central skill. */
const LIB = {
  list: (s?: string) => (s === 'active' ? [row('webterm-release'), row('webterm-off', { enabled: false }), row('webterm-rule', { audience: 'central' })] : []),
  descriptions: () => new Map<string, string>(),
} as unknown as SkillLookup

beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db); adds = []; updates = []; bridges = []
  const ws = { id: 'w-p1', name: 'Alpha WS', cwd: '/srv/alpha', nodes: BOARD, get bridges() { return bridges } } as WorkspaceRecord
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? ws : null))
})
afterEach(() => { unregister(); f.close() })

function ctx(skills: SkillLookup | null = LIB): ToolCtx {
  const registry = createRegistry()
  createCanvasActDefs({ canvas: () => canvas, browserOn: () => true, skills: () => skills }).forEach((d) => registry.register(d))
  createCanvasEditDefs({ canvas: () => canvas }).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R1', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
const open = (input: Record<string, unknown>, c = ctx()) => execTool(c, 'canvas.open', { projectId: 'p1', ...input })
const edit = (ops: unknown[]) => execTool(ctx(), 'canvas.edit', { projectId: 'p1', ops })

describe('canvas.open kind "skill"', () => {
  it('places a collapsed reference node and attaches it in the same call: skill -> agent, kind skill, anchored beside the agent', async () => {
    expect(await open({ kind: 'skill', skill: 'webterm-release', connectTo: 'Kiwi' })).toMatchObject({ ok: true, data: { count: 1, kind: 'skill' } })
    const node = adds[0].nodes[0]
    expect(node).toMatchObject({ kind: 'skill', skill: 'webterm-release', seenVersion: '3', collapsed: true, ...SKILL_NODE_SIZE })
    expect(adds[0].anchorNodeId).toBe('a1')
    expect(adds[0].bridges).toEqual([{ id: `bridge-${node.id}-a1`, source: node.id, target: 'a1', kind: 'skill' }])
  })

  it('the cable always runs skill -> agent, even when direction says "from"; an Agent Chat takes skills too; no connectTo = no cable', async () => {
    await open({ kind: 'skill', skill: 'webterm-release', connectTo: 'Plum', direction: 'from' })
    expect(adds[0].bridges?.[0]).toMatchObject({ source: adds[0].nodes[0].id, target: 'c1', kind: 'skill' })
    adds = []
    expect(await open({ kind: 'skill', skill: 'webterm-release' })).toMatchObject({ ok: true })
    expect(adds[0].bridges).toBeUndefined()
  })

  it('an unknown, switched-off or central skill opens nothing (skill_unavailable, with its state)', async () => {
    expect(await open({ kind: 'skill', skill: 'webterm-nope', connectTo: 'Kiwi' })).toMatchObject({ ok: false, code: 'skill_unavailable', data: { state: 'missing' } })
    expect(await open({ kind: 'skill', skill: 'webterm-off' })).toMatchObject({ ok: false, code: 'skill_unavailable', data: { state: 'disabled' } })
    expect(await open({ kind: 'skill', skill: 'webterm-rule' })).toMatchObject({ ok: false, code: 'skill_unavailable', data: { state: 'missing' } })
    expect(adds).toEqual([])
  })

  it('refuses while Central skills are off', async () => {
    expect(await open({ kind: 'skill', skill: 'webterm-release' }, ctx(null))).toMatchObject({ ok: false, code: 'skills_off' })
    expect(adds).toEqual([])
  })

  it('a target that is not a Claude agent (terminal, Codex, another skill) is link_not_allowed and leaves no node', async () => {
    for (const to of ['Mango', 'Pear', 'Lime']) expect(await open({ kind: 'skill', skill: 'webterm-release', connectTo: to })).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(adds).toEqual([])
  })

  it('an unknown connectTo is node_not_found; an agent already holding the maximum is skill_limit and nothing is placed', async () => {
    expect(await open({ kind: 'skill', skill: 'webterm-release', connectTo: 'Otter' })).toMatchObject({ ok: false, code: 'node_not_found' })
    bridges = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => ({ id: `b${i}`, source: `s${i}`, target: 'a1', kind: 'skill' as const }))
    expect(await open({ kind: 'skill', skill: 'webterm-release', connectTo: 'Kiwi' })).toMatchObject({ ok: false, code: 'skill_limit' })
    expect(adds).toEqual([])
  })

  it('validates the shape: skill name required for the kind, forbidden for every other kind, and well-formed', async () => {
    for (const bad of [{ kind: 'skill' }, { kind: 'skill', skill: 'Not A Name' }, { kind: 'skill', skill: 'webterm-release', count: 2 }, { kind: 'terminal', skill: 'webterm-release' }]) {
      expect([bad, await open(bad)]).toEqual([bad, expect.objectContaining({ ok: false, code: 'invalid_shape' })])
    }
  })
})

describe('canvas.edit link / unlink with a skill node', () => {
  it('attaches in either argument order as source=skill, kind skill; an existing cable is kept', async () => {
    await edit([{ op: 'link', from: 'Lime', to: 'Kiwi' }])
    expect(updates[0].bridgesAdd).toEqual([{ id: 'bridge-sk1-a1', source: 'sk1', target: 'a1', kind: 'skill' }])
    updates = []
    await edit([{ op: 'link', from: 'Plum', to: 'sk1' }])
    expect(updates[0].bridgesAdd).toEqual([{ id: 'bridge-sk1-c1', source: 'sk1', target: 'c1', kind: 'skill' }])
    updates = []
    bridges = [{ id: 'bridge-sk1-a1', source: 'sk1', target: 'a1', kind: 'skill' }]
    await edit([{ op: 'link', from: 'a1', to: 'sk1' }])
    expect(updates[0].bridgesAdd).toEqual([])
  })

  it('refuses a skill to anything but a Claude agent, and a skill to a skill', async () => {
    for (const to of ['Mango', 'Pear']) expect(await edit([{ op: 'link', from: 'Lime', to }])).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(await edit([{ op: 'link', from: 'Lime', to: 'Lime' }])).toMatchObject({ ok: false, code: 'link_not_allowed' })
    expect(updates).toEqual([])
  })

  it('refuses the ninth skill on one agent (skill_limit)', async () => {
    bridges = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => ({ id: `b${i}`, source: `s${i}`, target: 'a1', kind: 'skill' as const }))
    expect(await edit([{ op: 'link', from: 'Lime', to: 'Kiwi' }])).toMatchObject({ ok: false, code: 'skill_limit', data: { max: MAX_ATTACHED_SKILLS } })
    expect(updates).toEqual([])
  })

  it('unlink detaches by pair (either direction) or by cable id', async () => {
    bridges = [{ id: 'bridge-sk1-a1', source: 'sk1', target: 'a1', kind: 'skill' }]
    await edit([{ op: 'unlink', from: 'Kiwi', to: 'Lime' }])
    expect(updates[0].bridgesRemove).toEqual(['bridge-sk1-a1'])
    updates = []
    await edit([{ op: 'unlink', cable: 'bridge-sk1-a1' }])
    expect(updates[0].bridgesRemove).toEqual(['bridge-sk1-a1'])
  })
})
