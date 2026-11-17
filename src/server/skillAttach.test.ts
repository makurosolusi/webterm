import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { MAX_ATTACHED_SKILLS, SKILL_DESCRIPTION_MAX } from '../shared/skillPorts'
import type { SkillRecord, SkillStatus } from './central/contracts/skill.types'
import { buildLinkDoc } from './contextLinkRoute'
import { linkedBrowsers } from './linkAwareness'
import { linkEntries } from './linkNote'
import { attachedSkillNames, attachedSkills, oneLineDescription, skillState, type SkillLookup } from './skillAttach'

const rec = (name: string, o: Partial<SkillRecord> = {}): SkillRecord => ({
  name, version: '2', sha256: null, status: 'active', origin: 'human', audience: 'canvas', caps: [], createdAt: 0, proposedBy: null, approvedBy: null, approvedAt: null, evalScore: null, ...o,
})
/** Test-only library: active rows by name, disabled rows by name, descriptions. */
function lib(active: SkillRecord[], disabled: SkillRecord[] = [], desc: Record<string, string> = {}): SkillLookup {
  return {
    list: (status?: SkillStatus) => (status === 'active' ? active : status === 'disabled' ? disabled : []),
    descriptions: () => new Map(Object.entries(desc)),
  } as unknown as SkillLookup
}

function board(skills: string[], cableKind: 'skill' | 'context' = 'skill', host: Workspace['nodes'][number] = { id: 'a', kind: 'agent', x: 0, y: 0, agentId: 'claude' }): Workspace {
  return {
    id: 'w', name: 'B', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 1,
    nodes: [host, ...skills.map((skill, i) => ({ id: `s${i}`, kind: 'skill' as const, x: 0, y: 0, skill }))],
    bridges: skills.map((_, i) => ({ id: `b${i}`, source: `s${i}`, target: host.id, kind: cableKind })),
  }
}

describe('attachedSkillNames: the cables of the stored board decide', () => {
  it('lists the skills of skill nodes cabled to the agent, in cable order, once each', () => {
    expect(attachedSkillNames(board(['webterm-a', 'webterm-b', 'webterm-a']), 'a')).toEqual(['webterm-a', 'webterm-b'])
  })

  it('a node with no cable, a missing host, a non-host and a context cable attach nothing', () => {
    const ws = board(['webterm-a'])
    expect(attachedSkillNames({ ...ws, bridges: [] }, 'a')).toEqual([])
    expect(attachedSkillNames(ws, 'ghost')).toEqual([])
    expect(attachedSkillNames(board(['webterm-a'], 'skill', { id: 'a', kind: 'agent', x: 0, y: 0, agentId: 'codex' }), 'a')).toEqual([])
    expect(attachedSkillNames(board(['webterm-a'], 'context'), 'a')).toEqual([])
  })

  it('a cable whose skill node was removed attaches nothing (agent removed or skill node removed = detached)', () => {
    const ws = board(['webterm-a', 'webterm-b'])
    expect(attachedSkillNames({ ...ws, nodes: ws.nodes.filter((n) => n.id !== 's0') }, 'a')).toEqual(['webterm-b'])
    expect(attachedSkillNames({ ...ws, nodes: ws.nodes.filter((n) => n.id !== 'a') }, 'a')).toEqual([])
  })

  it('a skill node cabled to another agent does not leak to this one; a cable pointing the wrong way attaches nothing', () => {
    const ws = board(['webterm-a'])
    const other: Workspace = { ...ws, nodes: [...ws.nodes, { id: 'b', kind: 'agent', x: 0, y: 0, agentId: 'claude' }] }
    expect(attachedSkillNames(other, 'b')).toEqual([])
    expect(attachedSkillNames({ ...ws, bridges: [{ id: 'r', source: 'a', target: 's0', kind: 'skill' }] }, 'a')).toEqual([])
  })

  it('stops at the per-agent cap', () => {
    const many = Array.from({ length: MAX_ATTACHED_SKILLS + 3 }, (_, i) => `webterm-s${i}`)
    expect(attachedSkillNames(board(many), 'a')).toHaveLength(MAX_ATTACHED_SKILLS)
  })
})

describe('node reference semantics: the live library decides the state', () => {
  const l = lib([rec('webterm-on', { version: '3' }), rec('webterm-off', { enabled: false }), rec('webterm-rule', { audience: 'central' })], [rec('webterm-hash', { status: 'disabled' })], { 'webterm-on': 'Does the thing.' })

  it('follows the ACTIVE version and description', () => {
    expect(skillState(l, 'webterm-on')).toEqual({ state: 'active', version: '3', description: 'Does the thing.' })
    expect(skillState(lib([rec('webterm-on', { version: '4' })]), 'webterm-on')).toMatchObject({ state: 'active', version: '4' })
  })

  it('switched off or hash-disabled = disabled; unknown or a central skill = missing', () => {
    expect(skillState(l, 'webterm-off')).toEqual({ state: 'disabled' })
    expect(skillState(l, 'webterm-hash')).toEqual({ state: 'disabled' })
    expect(skillState(l, 'webterm-nope')).toEqual({ state: 'missing' })
    expect(skillState(l, 'webterm-rule')).toEqual({ state: 'missing' })
  })

  it('attachedSkills keeps only available ones, so disabled and missing attachments have no effect (and nothing is deleted from the board)', () => {
    const ws = board(['webterm-on', 'webterm-off', 'webterm-hash', 'webterm-nope', 'webterm-rule'])
    expect(attachedSkills(ws, 'a', l).map((s) => s.name)).toEqual(['webterm-on'])
    expect(ws.bridges).toHaveLength(5)
    expect(attachedSkills(ws, 'a', null)).toEqual([])
  })
})

describe('descriptions are one capped line (token bound)', () => {
  it('flattens control characters and newlines and cuts at the cap', () => {
    expect(oneLineDescription('a\n\nb‮ c\u0007')).toBe('a b c')
    const cut = oneLineDescription('x'.repeat(SKILL_DESCRIPTION_MAX + 50))
    expect(cut).toHaveLength(SKILL_DESCRIPTION_MAX + 1)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('a skill cable is not a context link', () => {
  it('stays out of the peer roster, the browser list and the link note entries', () => {
    const ws = board(['webterm-a'])
    expect(buildLinkDoc(ws, 'a').links).toEqual([])
    expect(linkedBrowsers(ws, 'a')).toEqual([])
    expect(linkEntries(ws, 'a')).toEqual([])
  })
})
