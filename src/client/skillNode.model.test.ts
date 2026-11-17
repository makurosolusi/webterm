import { describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { MarkerType } from '@xyflow/react'
import { normalizeWorkspace } from '../shared/workspace.schema'
import { MAX_ATTACHED_SKILLS, SKILL_NODE_SIZE, SKILL_OUT, SKILLS_IN } from '../shared/skillPorts'
import type { CanvasSkillsLoad } from './skillNode.api'
import { attachable, cardState, isUnavailable, versionChanged } from './skillNode.model'
import { skillEntries } from './skillNode.entries'
import { attachedCount, selectedSkillHost, skillCable, skillNodeSpec } from './skillNode.add'
import { buildCanvasMenuRows, MENU_LABELS } from './canvasMenu.model'
import { decorateEdges } from './canvasStyle'
import { canLink, isValidConnection } from './floatingEdge'
import { toBridge, toFlow, toFlowEdge, toWsNode } from './store'
import { nodeRowLabel } from './nodeList'

const ready = (...skills: Array<[string, string, boolean?, string?]>): CanvasSkillsLoad => ({
  status: 'ready', skills: skills.map(([name, version, enabled = true, description = `${name} desc`]) => ({ name, version, enabled, description })),
})

describe('node reference semantics: what the card shows', () => {
  it('follows the active version and description of the named skill', () => {
    expect(cardState(ready(['webterm-a', '4']), 'webterm-a')).toEqual({ kind: 'active', version: '4', description: 'webterm-a desc' })
  })

  it('switched off = disabled, not in the library = missing; both are Unavailable, neither deletes anything', () => {
    expect(cardState(ready(['webterm-a', '1', false]), 'webterm-a')).toEqual({ kind: 'disabled' })
    expect(cardState(ready(['webterm-a', '1']), 'webterm-gone')).toEqual({ kind: 'missing' })
    expect(cardState(ready(), undefined)).toEqual({ kind: 'missing' })
    expect([{ kind: 'disabled' }, { kind: 'missing' }].map((s) => isUnavailable(s as never))).toEqual([true, true])
    expect(isUnavailable({ kind: 'active', version: '1', description: '' })).toBe(false)
  })

  it('loading, failed and off are their own states (never read as missing)', () => {
    for (const status of ['loading', 'error', 'off'] as const) expect(cardState({ status }, 'webterm-a')).toEqual({ kind: status })
  })

  it('flags a version that moved since the node saw one, and nothing before it saw any', () => {
    expect(versionChanged('1', '2')).toBe(true)
    expect(versionChanged('2', '2')).toBe(false)
    expect(versionChanged(undefined, '2')).toBe(false)
  })

  it('pickers offer only switched-on skills, sorted by name', () => {
    const l = ready(['webterm-b', '1'], ['webterm-a', '1'], ['webterm-c', '1', false]) as Extract<CanvasSkillsLoad, { status: 'ready' }>
    expect(attachable(l.skills).map((x) => x.name)).toEqual(['webterm-a', 'webterm-b'])
  })
})

describe('skill picker rows', () => {
  const add = vi.fn()
  it('has a visible disabled row for loading / failed / off / empty instead of a silent empty list', () => {
    const rows = (l: CanvasSkillsLoad) => skillEntries(l, add).map((e) => [e.label, e.disabled])
    expect(rows({ status: 'loading' })).toEqual([['Loading skills…', true]])
    expect(rows({ status: 'error' })).toEqual([['Could not load skills', true]])
    expect(rows({ status: 'off' })).toEqual([['Central skills are off', true]])
    expect(rows(ready())).toEqual([['No active canvas skills yet', true]])
    expect(rows(ready(['webterm-a', '1', false]))).toEqual([['No active canvas skills yet', true]])
  })

  it('lists active canvas skills with their description and spawns with name + version at the given point', () => {
    const entries = skillEntries(ready(['webterm-a', '7', true, 'Ship it.']), add)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'webterm-a', label: 'webterm-a', description: 'Ship it.', group: 'Canvas skills' })
    entries[0].spawn({ x: 5, y: 6 })
    expect(add).toHaveBeenCalledWith({ name: 'webterm-a', version: '7' }, { x: 5, y: 6 })
  })
})

describe('skill node persistence and cables', () => {
  it('a skill node round-trips through the board (name + seen version), at the collapsed card size', () => {
    const ws = { ...skillNodeSpec('s1', { name: 'webterm-a', version: '3' }), x: 1, y: 2 }
    expect(ws).toMatchObject({ kind: 'skill', skill: 'webterm-a', seenVersion: '3', collapsed: true, ...SKILL_NODE_SIZE })
    const flow = toFlow(ws)
    expect(flow.type).toBe('skill')
    expect(toWsNode(flow)).toMatchObject({ kind: 'skill', skill: 'webterm-a', seenVersion: '3' })
    expect(toFlow({ id: 'x', kind: 'skill', x: 0, y: 0, skill: 'webterm-a' })).toMatchObject({ width: SKILL_NODE_SIZE.width, height: SKILL_NODE_SIZE.height })
    expect(nodeRowLabel({ id: 'x', kind: 'skill', x: 0, y: 0, skill: 'webterm-a' })).toBe('webterm-a')
  })

  it('a skill bridge is a skill edge on both typed handles and survives the round trip; context bridges are untouched', () => {
    const edge = toFlowEdge({ id: 'b', source: 's', target: 'a', kind: 'skill' })
    expect(edge).toMatchObject({ type: 'skill', sourceHandle: SKILL_OUT, targetHandle: SKILLS_IN, data: { kind: 'skill' } })
    expect(toBridge(edge)).toEqual({ id: 'b', source: 's', target: 'a', kind: 'skill' })
    const ctx = toFlowEdge({ id: 'c', source: 'a', target: 'b', kind: 'context' })
    expect(ctx).toMatchObject({ type: 'context' })
    expect(ctx.sourceHandle).toBeUndefined()
  })

  it('the server keeps kind skill and the skill name of a stored board, and drops junk skill fields', () => {
    const out = normalizeWorkspace({
      name: 'B', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: 's', kind: 'skill', x: 0, y: 0, skill: 'webterm-a', seenVersion: 3 }, { id: 'a', kind: 'agent', x: 0, y: 0 }],
      bridges: [{ id: 'b', source: 's', target: 'a', kind: 'skill' }, { id: 'c', source: 'a', target: 's', kind: 'weird' }],
    })
    expect(out.issues).toEqual([])
    expect(out.board.nodes[0]).toMatchObject({ kind: 'skill', skill: 'webterm-a' })
    expect(out.board.nodes[0].seenVersion).toBeUndefined()
    expect(out.board.bridges.map((b) => b.kind)).toEqual(['skill', 'context'])
  })

  it('skill cables are drawn dashed, arrowless and never hidden by "hide links"', () => {
    const nodes = [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { hideLinks: true } }, { id: 's', type: 'skill', position: { x: 0, y: 0 }, data: {} }] as Node[]
    const [skill, ctx] = decorateEdges([toFlowEdge({ id: 'b', source: 's', target: 'a', kind: 'skill' }), toFlowEdge({ id: 'c', source: 'a', target: 's', kind: 'context' })], nodes)
    expect(skill).toMatchObject({ hidden: false, style: { strokeDasharray: '5 4' } })
    expect(skill.markerEnd).toBeUndefined()
    expect(skill.label).toBeUndefined()
    expect(ctx.hidden).toBe(true)
    expect(ctx.markerEnd).toMatchObject({ type: MarkerType.Arrow })
  })

  it('"Add to canvas" cables only the ONE selected Claude agent, and never past the cap or twice', () => {
    const node = (id: string, type: string, selected: boolean, agentId?: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: { agentId }, selected })
    expect(selectedSkillHost([node('a', 'agent', true, 'claude'), node('t', 'terminal', false)])?.id).toBe('a')
    expect(selectedSkillHost([node('a', 'agent', true, 'claude'), node('b', 'agent', true, 'claude')])).toBeUndefined()
    expect(selectedSkillHost([node('t', 'terminal', true)])).toBeUndefined()
    expect(selectedSkillHost([node('x', 'agent', true, 'codex')])).toBeUndefined()
    expect(selectedSkillHost([node('c', 'agentChat', true, 'claude')])?.id).toBe('c')

    const cable = skillCable([], 's1', 'a')
    expect('edge' in cable && cable.edge).toMatchObject({ id: 'bridge-s1-a', source: 's1', target: 'a', type: 'skill' })
    const full: Edge[] = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => toFlowEdge({ id: `b${i}`, source: `s${i}`, target: 'a', kind: 'skill' }))
    expect(attachedCount(full, 'a')).toBe(MAX_ATTACHED_SKILLS)
    expect(skillCable(full, 'sN', 'a')).toEqual({ refused: 'limit' })
    expect(skillCable(full, 's0', 'a')).toEqual({ refused: 'exists' })
  })
})

describe('client canLink / isValidConnection agree with the shared rule', () => {
  const nodes = [
    { id: 's', type: 'skill', data: {} }, { id: 'a', type: 'agent', data: { agentId: 'claude' } }, { id: 'x', type: 'agent', data: { agentId: 'codex' } },
    { id: 'c', type: 'agentChat', data: { agentId: 'claude' } }, { id: 'b', type: 'browser', data: {} },
  ]
  it('typed handle validity matrix', () => {
    const ok = (source: string, sourceHandle: string, target: string, targetHandle: string) => isValidConnection(nodes, { source, sourceHandle, target, targetHandle })
    expect(ok('s', SKILL_OUT, 'a', SKILLS_IN)).toBe(true)
    expect(ok('s', SKILL_OUT, 'c', SKILLS_IN)).toBe(true)
    expect(ok('s', SKILL_OUT, 'a', 'link-in')).toBe(false)
    expect(ok('a', 'link-out', 'c', SKILLS_IN)).toBe(false)
    expect(ok('b', 'link-out', 'a', SKILLS_IN)).toBe(false)
    expect(ok('s', SKILL_OUT, 'x', SKILLS_IN)).toBe(false)
    expect(ok('s', SKILL_OUT, 'b', 'link-in')).toBe(false)
    expect(ok('a', 'link-out', 'c', 'link-in')).toBe(true) // context links keep their old rules
  })

  it('canLink (handle menu) pairs a skill with Claude agents only, in either order', () => {
    expect(canLink({ id: 's', kind: 'skill' }, { id: 'a', kind: 'agent', agentId: 'claude' })).toBe(true)
    expect(canLink({ id: 'c', kind: 'agentChat', agentId: 'claude' }, { id: 's', kind: 'skill' })).toBe(true)
    expect(canLink({ id: 's', kind: 'skill' }, { id: 'b', kind: 'browser' })).toBe(false)
    expect(canLink({ id: 's', kind: 'skill' }, { id: 'x', kind: 'agent', agentId: 'codex' })).toBe(false)
  })
})

describe('pane menu', () => {
  const ctx = { nodeCount: 0, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
  const base = { addTerminal: vi.fn(), addAgent: vi.fn(), addFiles: vi.fn(), fitView: vi.fn() }
  it('lists "Skill…" only when the board can place one', () => {
    const keys = (h: Parameters<typeof buildCanvasMenuRows>[0]) => buildCanvasMenuRows(h, ctx).map((r) => ('key' in r ? r.key : ''))
    expect(keys(base)).not.toContain('skill')
    const withSkill = buildCanvasMenuRows({ ...base, addSkill: vi.fn() }, ctx).find((r) => 'key' in r && r.key === 'skill')
    expect(withSkill).toMatchObject({ label: MENU_LABELS.skill, icon: 'skill' })
    expect(MENU_LABELS.skill).toBe('Skill…')
  })
})
