// The Central skill author's web protocol (prompt behaviour) and that its provenance Notes lines pass the skill lint.
import { describe, expect, it } from 'bun:test'
import { lintSkill } from '../skills/skillLint'
import { SKILL_AUTHOR_PROMPT } from './conversationMode'

describe('central skill author web protocol', () => {
  it('requires reading a mentioned URL first, honest failure, and the Sources status', () => {
    const p = SKILL_AUTHOR_PROMPT
    expect(p).toContain('you MUST call browser_read for it BEFORE the SPEC and say what you read')
    expect(p).toContain('say so honestly and offer: paste the text here, or continue from general knowledge')
    expect(p).toContain('"Written from general knowledge, not verified"')
    expect(p).toContain('"Sources: <host>|none"')
    expect(p).toContain('"Sources: <host>, read <YYYY-MM-DD>"')
    expect(p).toContain('never claim it is unavailable without having tried')
  })

  it('a central skill with the provenance and general-knowledge Notes lines passes the lint', () => {
    const body = ['## Purpose', 'p', '## When to use', 'w', '## Steps', '1. a', '2. b', '## Do not', 'd', '## Done when', 'x', '## Notes', 'Sources: bulma.io, read 2026-11-17', 'Written from general knowledge, not verified'].join('\n')
    const text = `---\nname: webterm-x\ndescription: d\nmetadata:\n  webterm.title: "A title"\n  webterm.audience: central\n---\n${body}\n`
    expect(lintSkill(text, { requireStructure: true }).issues).toEqual([])
  })
})
