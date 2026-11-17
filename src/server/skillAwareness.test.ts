import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { MAX_ATTACHED_SKILLS, SKILL_DESCRIPTION_MAX } from '../shared/skillPorts'
import type { SkillRecord, SkillStatus } from './central/contracts/skill.types'
import { buildSkillNotice, forgetSkillNotice, skillNoticeFor } from './skillAwareness'
import type { AttachedSkill, SkillLookup } from './skillAttach'

const sk = (name: string, description = `${name} does a thing.`, version = '1'): AttachedSkill => ({ name, version, description })

describe('buildSkillNotice: name + description only, the body stays behind `skills get`', () => {
  it('SessionStart lists the index with version and description, and how to read one', () => {
    const text = buildSkillNotice('SessionStart', [sk('webterm-a', 'Ship a release.', '3')], undefined) ?? ''
    expect(text).toContain('- webterm-a (v3): Ship a release.')
    expect(text).toContain('webterm skills get <name>')
    expect(text).toContain('data written by skill authors')
  })

  it('SessionStart with nothing attached, and events without an additionalContext channel, say nothing', () => {
    expect(buildSkillNotice('SessionStart', [], undefined)).toBeNull()
    expect(buildSkillNotice('Stop', [sk('webterm-a')], undefined)).toBeNull()
    expect(buildSkillNotice(undefined, [sk('webterm-a')], undefined)).toBeNull()
  })

  it('UserPromptSubmit announces only the net change: attach, detach, version or description change', () => {
    const a = sk('webterm-a'), b = sk('webterm-b')
    expect(buildSkillNotice('UserPromptSubmit', [a, b], [a, b])).toBeNull()
    expect(buildSkillNotice('UserPromptSubmit', [a, b], [a])).toMatch(/were attached[\s\S]*webterm-b/)
    const gone = buildSkillNotice('UserPromptSubmit', [a], [a, b]) ?? ''
    expect(gone).toContain('no longer available')
    expect(gone).toContain('webterm-b')
    expect(gone).not.toContain('- webterm-a')
    expect(buildSkillNotice('UserPromptSubmit', [sk('webterm-a', 'x', '2')], [sk('webterm-a', 'x', '1')])).toMatch(/changed[\s\S]*\(v2\)/)
  })

  it('stays small at the cap: eight maximal descriptions fit far below the 10k hook cap', () => {
    const big = Array.from({ length: MAX_ATTACHED_SKILLS }, (_, i) => sk(`webterm-s${i}`, 'd'.repeat(SKILL_DESCRIPTION_MAX)))
    expect((buildSkillNotice('SessionStart', big, undefined) ?? '').length).toBeLessThan(2500)
  })
})

const rec = (name: string, o: Partial<SkillRecord> = {}): SkillRecord => ({
  name, version: '1', sha256: null, status: 'active', origin: 'human', audience: 'canvas', caps: [], createdAt: 0, proposedBy: null, approvedBy: null, approvedAt: null, evalScore: null, ...o,
})

describe('skillNoticeFor: refreshed when cables change, without a restart', () => {
  const lib = (rows: SkillRecord[]): SkillLookup => ({ list: (s?: SkillStatus) => (s === 'active' ? rows : []), descriptions: () => new Map(rows.map((r) => [r.name, `${r.name} helps.`])) }) as unknown as SkillLookup
  const ws = (cabled: string[]): Workspace => ({
    id: 'w', name: 'B', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 1,
    nodes: [{ id: 'a', kind: 'agent', x: 0, y: 0, agentId: 'claude' }, ...cabled.map((skill, i) => ({ id: `s${i}`, kind: 'skill' as const, x: 0, y: 0, skill }))],
    bridges: cabled.map((_, i) => ({ id: `b${i}`, source: `s${i}`, target: 'a', kind: 'skill' as const })),
  })
  const L = lib([rec('webterm-a'), rec('webterm-b'), rec('webterm-c', { enabled: false })])

  it('learns of an attach and a detach on the next prompt, and a coalesced wire+unwire says nothing', () => {
    const id = 'a' // the agent node of ws()
    expect(skillNoticeFor(id, 'SessionStart', ws(['webterm-a']), L)).toContain('webterm-a')
    expect(skillNoticeFor(id, 'UserPromptSubmit', ws(['webterm-a']), L)).toBeNull()
    expect(skillNoticeFor(id, 'UserPromptSubmit', ws(['webterm-a', 'webterm-b']), L)).toMatch(/attached[\s\S]*webterm-b/)
    expect(skillNoticeFor(id, 'UserPromptSubmit', ws(['webterm-a']), L)).toMatch(/no longer available[\s\S]*webterm-b/)
    // Stop does not swallow a change; attach + detach between two prompts is the same set.
    expect(skillNoticeFor(id, 'Stop', ws(['webterm-a', 'webterm-b']), L)).toBeNull()
    expect(skillNoticeFor(id, 'UserPromptSubmit', ws(['webterm-a']), L)).toBeNull()
    forgetSkillNotice(id)
  })

  it('a disabled attachment is not announced as available; with Central skills off nothing is', () => {
    const id = 'a'
    expect(skillNoticeFor(id, 'SessionStart', ws(['webterm-c']), L)).toBeNull()
    expect(skillNoticeFor(id, 'SessionStart', ws(['webterm-a']), null)).toBeNull()
    forgetSkillNotice(id)
  })
})
