import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { MAX_ATTACHED_SKILLS, SKILL_DESCRIPTION_MAX } from '../../shared/skillPorts'
import type { Workspace, WsNode } from '../../shared/workspace'
import { agentSkillList } from '../central/ca2Routes.agentSkill'
import type { Ca2Handle } from '../central/ca2Boot'
import { attachedSkillNames, attachedSkills, type AttachedSkill, type SkillLookup } from '../skillAttach'
import { buildAgentChatOptions } from './agentChat.options'
import { FakeQuery } from './agentChat.fakeQuery'
import { AgentChatPool, type AgentChatTarget } from './agentChat.pool'
import { agentChatRoleFor } from './agentChat.role'
import { attachedSkillsIndex, skillTurnNote } from './agentChat.skills'

const allow: CanUseTool = async (_n, input) => ({ behavior: 'allow', updatedInput: input })
const sk = (name: string, version = '1', description = `does ${name}`): AttachedSkill => ({ name, version, description })
const dir = mkdtempSync(join(tmpdir(), 'chat-skills-')) // test-only: never the real data dir
const build = (over: Partial<Parameters<typeof buildAgentChatOptions>[0]> = {}) =>
  buildAgentChatOptions({ nodeId: 'n-1', port: 1, cwd: dir, mode: 'manual', canUseTool: allow, abort: new AbortController(), uploadsRoot: dir, parentEnv: { PATH: '/usr/bin', HOME: dir, CLAUDE_CONFIG_DIR: dir }, ...over }).options
const appendOf = (o: ReturnType<typeof build>): string | undefined => {
  const sp = o.systemPrompt
  return sp && typeof sp === 'object' && !Array.isArray(sp) && 'append' in sp ? sp.append : undefined
}

describe('system prompt index', () => {
  test('lists name, version and description once, with the on-demand sentence', () => {
    const a = appendOf(build({ attachedSkills: [sk('webterm-a', '3', 'does A'), sk('webterm-b')] }))
    expect(a).toContain('Skills attached to you (canvas skills): webterm-a v3: does A | webterm-b v1: does webterm-b.')
    expect(a).toContain('`webterm skills get <name>`')
    expect(a).toContain('only these are available to you')
    expect(build({ attachedSkills: [sk('webterm-a')] }).systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
  })

  test('nothing attached: no system prompt override at all', () => {
    expect(build({ attachedSkills: [] }).systemPrompt).toBe(undefined)
    expect(build().systemPrompt).toBe(undefined)
    expect(attachedSkillsIndex(undefined)).toBe(undefined)
  })

  test('skill-author keeps its role and lock, with the index after the role', () => {
    const o = build({ preset: 'skill-author', attachedSkills: [sk('webterm-a')] })
    const a = appendOf(o) ?? ''
    expect(a.startsWith(agentChatRoleFor('skill-author') ?? 'x')).toBe(true)
    expect(a.indexOf('Skills attached to you')).toBeGreaterThan(a.indexOf('webterm skill author'))
    expect(o.allowedTools ?? o.tools).toEqual(build({ preset: 'skill-author' }).allowedTools ?? build({ preset: 'skill-author' }).tools)
    expect(appendOf(build({ preset: 'skill-author' }))).not.toContain('Skills attached to you')
  })

  test('the cap holds even if a caller hands more than MAX_ATTACHED_SKILLS', () => {
    const many = Array.from({ length: MAX_ATTACHED_SKILLS + 4 }, (_, i) => sk(`webterm-s${i}`))
    const a = appendOf(build({ attachedSkills: many })) ?? ''
    expect(a.match(/ v1: /g)).toHaveLength(MAX_ATTACHED_SKILLS)
  })
})

describe('skillTurnNote', () => {
  test('names additions, removals and version changes; undefined when the set is unchanged', () => {
    expect(skillTurnNote([sk('a')], [sk('a')])).toBe(undefined)
    expect(skillTurnNote([], [sk('a'), sk('b')])).toBe('[webterm] Skills attached: +a / +b')
    expect(skillTurnNote([sk('a'), sk('b')], [sk('b')])).toBe('[webterm] Skills attached: -a')
    expect(skillTurnNote([sk('a', '1')], [sk('a', '2')])).toBe('[webterm] Skills attached: ~a v2')
  })
})

const ws = (nodes: WsNode[]): Workspace => ({ id: 'w', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes })
const chat = (id: string): WsNode => ({ id, kind: 'agentChat', x: 0, y: 0 })

function rig() {
  const w = ws([chat('c1'), chat('c2')])
  const sets = new Map<string, AttachedSkill[]>()
  const opens: FakeQuery[] = []
  const pool = new AgentChatPool({
    lookup: (id) => { const node = w.nodes.find((n) => n.id === id); return node ? { ws: w, node } : undefined },
    opener: () => (_r, _c, _a, input) => { const fq = new FakeQuery(input.prompt); opens.push(fq); return fq.asQuery() },
    attached: (t: AgentChatTarget) => sets.get(t.node.id) ?? [],
  })
  return { pool, sets, opens }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
const sent = (fq: FakeQuery | undefined): string[] => (fq?.prompts ?? []).map((p) => String(p.message.content))

let current: AgentChatPool | undefined
afterEach(() => { current?.closeAll(); current = undefined })

describe('pool turn note', () => {
  test('first open announces through the prompt (no note); a change adds one visible note, an unchanged turn none', async () => {
    const { pool, sets, opens } = rig()
    current = pool
    sets.set('c1', [sk('a')])
    pool.send('c1', 'one')
    pool.send('c1', 'two')
    sets.set('c1', [sk('a'), sk('b')])
    pool.send('c1', 'three')
    pool.send('c1', 'four')
    await tick()
    expect(sent(opens[0])).toEqual(['one', 'two', '[webterm] Skills attached: +b\n\nthree', 'four'])
  })

  test('no leakage between nodes; closing clears the memo so a fresh session starts from its own open', async () => {
    const { pool, sets, opens } = rig()
    current = pool
    pool.send('c1', 'x')
    pool.send('c2', 'y')
    sets.set('c1', [sk('a')])
    pool.send('c2', 'y2')
    await tick()
    expect(sent(opens[1])).toEqual(['y', 'y2'])
    pool.send('c1', 'x2')
    await tick()
    expect(sent(opens[0])).toEqual(['x', '[webterm] Skills attached: +a\n\nx2'])
    pool.close('c1')
    pool.send('c1', 'again')
    await tick()
    expect(sent(opens[2])).toEqual(['again'])
  })
})

describe('attached set end to end (chat node, production rules)', () => {
  const rec = (name: string) => ({ name, version: '2', status: 'active', audience: 'canvas', enabled: true })
  const lib = (names: string[]): SkillLookup => ({ list: (s?: string) => (s === 'active' ? names.map(rec) : []), descriptions: () => new Map(names.map((n) => [n, `does ${n}`])) }) as unknown as SkillLookup
  const board = (): Workspace => ({
    ...ws([chat('c1'), { id: 's1', kind: 'skill', x: 0, y: 0, skill: 'webterm-a' } as WsNode, { id: 's2', kind: 'skill', x: 0, y: 0, skill: 'webterm-b' } as WsNode]),
    bridges: [{ id: 'b1', source: 's1', target: 'c1', kind: 'skill' }, { id: 'b2', source: 's2', target: 'c1', kind: 'skill' }],
  })

  test('options mention exactly the cabled skills; get works for them and answers not_attached for the rest', () => {
    const skills = lib(['webterm-a', 'webterm-b', 'webterm-other'])
    const w = board()
    const a = appendOf(build({ attachedSkills: attachedSkills(w, 'c1', skills) })) ?? ''
    expect(a).toContain('webterm-a v2')
    expect(a).toContain('webterm-b v2')
    expect(a).not.toContain('webterm-other')
    const names = attachedSkillNames(w, 'c1')
    const h = { skills: { ...skills, load: (n: string) => ({ record: { version: '2', audience: 'canvas', caps: [] }, body: `body of ${n}` }) } } as unknown as Ca2Handle
    expect(agentSkillList(h, 'c1', 'webterm-a', names).status).toBe(200)
    expect(agentSkillList(h, 'c1', 'webterm-other', names)).toMatchObject({ status: 404, body: { error: 'not_attached' } })
  })

  test('descriptions are cut at the shared limit before they reach the prompt', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX + 50)
    const skills = { list: (s?: string) => (s === 'active' ? [rec('webterm-a')] : []), descriptions: () => new Map([['webterm-a', long]]) } as unknown as SkillLookup
    const a = appendOf(build({ attachedSkills: attachedSkills(board(), 'c1', skills) })) ?? ''
    expect(a).not.toContain('x'.repeat(SKILL_DESCRIPTION_MAX + 1))
  })
})
