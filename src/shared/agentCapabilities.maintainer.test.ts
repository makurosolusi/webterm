// The maintainer profiles (docs/decisions/maintainer-agent.md, wave 1): what they are granted, the one registry-derived
// briefing rule, and that nothing that writes or touches credentials is granted.
import { describe, expect, test } from 'vitest'
import { CAPABILITIES, MAINTAINER_RULE, PROFILES, renderCapabilityBriefing, renderCapabilityLine, type CapabilityId, type ProfileId } from './agentCapabilities'

const MAINTAINERS: ProfileId[] = ['central.maintainer', 'chat.maintainer']

describe('maintainer profiles', () => {
  test('grant the diagnosis ability, and the chat one keeps the browser verbs of a plain chat', () => {
    for (const p of MAINTAINERS) expect(PROFILES[p].granted).toContain('ops.diagnose')
    for (const id of PROFILES['chat.default'].granted) expect(PROFILES['chat.maintainer'].granted).toContain(id)
  })

  test('the briefing carries the one rule and names every read-only capability', () => {
    for (const p of MAINTAINERS) {
      const text = renderCapabilityBriefing(p)
      expect(text).toContain(`Rule: ${MAINTAINER_RULE}`)
      expect(MAINTAINER_RULE).toContain('Never tell the user to run a shell command or send a screenshot')
    }
    const chat = renderCapabilityBriefing('chat.maintainer')
    for (const name of ['logs.summary', 'logs.query', 'doctor.run', 'config.read', 'instance.info']) expect(chat).toContain(name)
  })

  test('the rule is written once: no other profile carries it, so the steward and a plain chat stay unchanged', () => {
    for (const p of ['chat.default', 'central.steward', 'central.skill-author', 'chat.skill-author'] as ProfileId[]) {
      expect(PROFILES[p].granted).not.toContain('ops.diagnose')
      expect(renderCapabilityBriefing(p)).not.toContain(MAINTAINER_RULE)
      expect(renderCapabilityLine(p)).not.toContain('diagnose')
    }
  })

  test('no write or credential ability exists in the registry for a maintainer to be granted', () => {
    const ids = Object.keys(CAPABILITIES) as CapabilityId[]
    for (const p of MAINTAINERS) {
      const granted = PROFILES[p].granted.filter((id) => !PROFILES['chat.default'].granted.includes(id))
      expect(granted).toEqual(['ops.diagnose'])
    }
    expect(ids.filter((id) => /config\.write|doctor\.fix|secret|credential|token/i.test(id))).toEqual([])
    expect(CAPABILITIES['ops.diagnose'].summary).toContain('read-only')
  })
})
