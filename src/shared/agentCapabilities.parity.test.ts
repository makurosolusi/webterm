// Parity guard: what the registry says an agent may do == what is ENFORCED == what its prompt says. Any hand-written
// drift (a prompt that names a tool the lock refuses, a granted ability the lock blocks) turns this red.
import { describe, expect, it } from 'vitest'
import { agentChatLockFor, skillAuthorPreToolUse } from '../server/agentChat/agentChat.toolLock'
import { agentChatRoleFor } from '../server/agentChat/agentChat.role'
import { MODE_TOOLS, SKILL_AUTHOR_PROMPT, modeAllowsTool } from '../server/central/chat/conversationMode'
import { capabilitiesOf, grantedCentralTools, grantedChatFamilies, renderCapabilityBriefing, type ProfileId } from './agentCapabilities'

const cannotSection = (briefing: string): string => briefing.slice(briefing.indexOf('WHAT YOU CANNOT DO'))
const canSection = (briefing: string): string => briefing.slice(0, briefing.indexOf('WHAT YOU CANNOT DO'))

async function chatAllows(command: string): Promise<boolean> {
  const out = await skillAuthorPreToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never, undefined, { signal: new AbortController().signal })
  return (out as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'allow'
}

describe('central.skill-author: registry == enforcement == briefing', () => {
  const profile: ProfileId = 'central.skill-author'
  const briefing = renderCapabilityBriefing(profile)

  it('MODE_TOOLS is exactly the granted tools', () => {
    expect([...MODE_TOOLS['skill-author']]).toEqual(grantedCentralTools(profile))
  })

  for (const cap of capabilitiesOf(profile)) {
    it(`${cap.id} (${cap.level})`, () => {
      for (const tool of cap.central?.tools ?? []) expect(modeAllowsTool('skill-author', tool)).toBe(cap.level === 'granted')
      if (cap.level === 'granted') {
        expect(canSection(briefing)).toContain(cap.central!.usage)
      } else {
        expect(cannotSection(briefing)).toContain(cap.denied)
        expect(canSection(briefing)).not.toContain(cap.central?.usage ?? '\0')
      }
    })
  }

  it('the web ability is granted and driving is not', () => {
    expect(modeAllowsTool('skill-author', 'browser_read')).toBe(true)
    for (const t of ['browser_act', 'browser_open', 'browser_status']) expect(modeAllowsTool('skill-author', t)).toBe(false)
  })

  it('the prompt carries the rendered briefing and names no tool outside the enforced set', () => {
    expect(SKILL_AUTHOR_PROMPT).toContain(briefing)
    const named = SKILL_AUTHOR_PROMPT.match(/\b(?:skill|browser|canvas|agent|memory|channel|project|task|playbook|chat|state|reminder)_[a-z_]+\b/g) ?? []
    const enforced = new Set(MODE_TOOLS['skill-author'].map((t) => t.replace(/\./g, '_')))
    expect(named.length).toBeGreaterThan(0)
    for (const n of named) expect(enforced.has(n), `prompt names ${n}`).toBe(true)
  })
})

describe('chat.skill-author: registry == enforcement == briefing', () => {
  const profile: ProfileId = 'chat.skill-author'
  const briefing = renderCapabilityBriefing(profile)

  for (const cap of capabilitiesOf(profile).filter((c) => c.chat?.example)) {
    it(`${cap.id} (${cap.level})`, async () => {
      expect(await chatAllows(cap.chat!.example)).toBe(cap.level === 'granted')
      if (cap.level === 'granted') expect(canSection(briefing)).toContain(cap.chat!.usage)
      else expect(cannotSection(briefing)).toContain(cap.denied)
    })
  }

  it('denies every other tool and shell shape', async () => {
    for (const c of ['ls', 'webterm browser click e1', 'webterm browser snapshot; ls', 'webterm skills list | cat', 'webterm canvas open']) expect(await chatAllows(c), c).toBe(false)
  })

  it('the lock allow-rules are the granted families', () => {
    expect(agentChatLockFor('skill-author')?.allowedTools).toEqual(grantedChatFamilies(profile).map((f) => `Bash(webterm ${f} *)`))
  })

  it('the role carries the briefing and names only granted command families and read-only browser verbs', () => {
    const role = agentChatRoleFor('skill-author') ?? ''
    expect(role).toContain(briefing)
    const families = new Set<string>(grantedChatFamilies(profile))
    for (const m of role.matchAll(/`webterm (\w+)(?: (\w+))?/g)) {
      expect(families.has(m[1]!), `role names webterm ${m[1]}`).toBe(true)
      if (m[1] === 'browser') expect(['open', 'navigate', 'snapshot']).toContain(m[2])
    }
  })
})
