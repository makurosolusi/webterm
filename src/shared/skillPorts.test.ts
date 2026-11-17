import { describe, expect, it } from 'vitest'
import { canSkillLink, isSkillHost, MAX_ATTACHED_SKILLS, SKILL_OUT, SKILLS_IN, skillConnection, type PortEnd } from './skillPorts'

const skill: PortEnd = { id: 's', kind: 'skill' }
const claude: PortEnd = { id: 'a', kind: 'agent', agentId: 'claude' }
const chat: PortEnd = { id: 'c', kind: 'agentChat', agentId: 'claude' }
const codex: PortEnd = { id: 'x', kind: 'agent', agentId: 'codex' }
const terminal: PortEnd = { id: 't', kind: 'terminal' }
const browser: PortEnd = { id: 'b', kind: 'browser' }

describe('which nodes have a Skills port', () => {
  it('only a Claude terminal agent and an agent chat', () => {
    expect(isSkillHost(claude)).toBe(true)
    expect(isSkillHost(chat)).toBe(true)
    for (const n of [codex, terminal, browser, skill, { id: 'f', kind: 'files' }, { id: 'p', kind: 'plan' }, { id: 'd', kind: 'diff' }]) expect([n.kind, isSkillHost(n)]).toEqual([n.kind, false])
  })
})

describe('typed handle validity matrix (drawn connection)', () => {
  const cases: Array<[string, PortEnd, string | undefined, PortEnd, string | undefined, boolean | undefined]> = [
    ['skill-out -> skills-in of a Claude agent', skill, SKILL_OUT, claude, SKILLS_IN, true],
    ['skill-out -> skills-in of an agent chat', skill, SKILL_OUT, chat, SKILLS_IN, true],
    ['skill-out -> link-in (context port)', skill, SKILL_OUT, claude, 'link-in', false],
    ['skill -> a handle-less target', skill, SKILL_OUT, claude, undefined, false],
    ['skill-out -> skills-in of a non-Claude agent', skill, SKILL_OUT, codex, SKILLS_IN, false],
    ['skill -> a browser', skill, SKILL_OUT, browser, SKILLS_IN, false],
    ['skill -> skill', skill, SKILL_OUT, { id: 's2', kind: 'skill' }, SKILLS_IN, false],
    ['agent link-out -> skills-in', claude, 'link-out', chat, SKILLS_IN, false],
    ['browser -> skills-in', browser, 'link-out', claude, SKILLS_IN, false],
    ['agent -> agent via the context ports (no skill involved)', claude, 'link-out', chat, 'link-in', undefined],
    ['browser -> agent via the context ports', browser, 'link-out', claude, 'link-in', undefined],
  ]
  for (const [name, a, ah, b, bh, want] of cases) it(name, () => { expect(skillConnection(a, ah, b, bh)).toBe(want) })
})

describe('pair rule without handles (handle menu, canvas.edit, canvas.open)', () => {
  it('a skill pairs with a skill host in either order, with nothing else', () => {
    expect(canSkillLink(skill, claude)).toBe(true)
    expect(canSkillLink(chat, skill)).toBe(true)
    for (const other of [codex, terminal, browser, { id: 's2', kind: 'skill' }]) expect(canSkillLink(skill, other)).toBe(false)
    expect(canSkillLink(skill, skill)).toBe(false)
  })

  it('is silent about pairs with no skill node', () => {
    expect(canSkillLink(claude, chat)).toBeUndefined()
    expect(canSkillLink(browser, claude)).toBeUndefined()
  })

  it('caps skills per agent at a small number so awareness cannot bloat', () => {
    expect(MAX_ATTACHED_SKILLS).toBe(8)
  })
})
