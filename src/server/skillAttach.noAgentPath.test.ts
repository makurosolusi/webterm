// A canvas agent can never attach or detach a skill (docs/decisions/skill-canvas-nodes.md): no capability it can
// call writes cables, the workspace routes need the root token, and the skill verbs it does have only read or propose.
import { describe, expect, it } from 'vitest'
import { isNodeTokenPath } from './auth'
import { SKILL_CAPABILITY_NAMES } from './capability/skill.capabilities'
import { TOOL_INDEX } from './cli/cli.registry'
import { SKILLS_USAGE } from './cli/cli.skills'

describe('no attach path for a canvas agent', () => {
  it('the node-token API surface has no cable, workspace or canvas write', () => {
    for (const p of ['/api/workspaces', '/api/workspaces/w1', '/api/canvas', '/api/central/skills', '/api/central/skills/webterm-x/enable']) expect([p, isNodeTokenPath(p)]).toEqual([p, false])
    const names = TOOL_INDEX.list().map((c) => c.name)
    expect(names.filter((n) => /canvas|bridge|cable|attach|detach|link/.test(n))).toEqual([])
  })

  it('the agent skill capabilities are exactly list and propose', () => {
    expect([...SKILL_CAPABILITY_NAMES]).toEqual(['skills.list', 'skills.propose'])
  })

  it('the CLI verbs for skills are list, propose, edit and get', () => {
    expect(SKILLS_USAGE).toBe('usage: webterm skills <list [name] | propose --name <webterm-slug> --description <text> [--audience canvas] [--caps a,b] [--body-file <path>|-] | edit <name> [--description <text>] [--caps a,b] [--body-file <path>|-] | get <name> [--json]>')
    expect(SKILLS_USAGE).not.toMatch(/attach|detach|link/)
  })
})
