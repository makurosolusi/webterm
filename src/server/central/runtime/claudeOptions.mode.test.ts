import { describe, expect, it } from 'vitest'
import { SKILL_AUTHOR_PROMPT, modePrompt } from '../chat/conversationMode'
import { CENTRAL_STEWARD_PROMPT, centralQueryOptions } from './claudeOptions'

describe('centralQueryOptions in skill-author mode', () => {
  const base = { newSessionId: 'uuid-1', maxTurns: 3, mcpConfig: '/run/t.mcp.json', cwd: '/work', env: { PATH: '/bin' }, abort: new AbortController() }
  const system = (o: ReturnType<typeof centralQueryOptions>): string => (o.systemPrompt as { append: string }).append

  it('swaps the steward prompt for the author role and allows exactly the three skill tools', () => {
    const o = centralQueryOptions({ ...base, mode: 'skill-author' })
    expect(system(o)).toBe(SKILL_AUTHOR_PROMPT)
    expect(system(o)).not.toContain('webterm Central, the steward')
    expect(o.allowedTools).toEqual(['mcp__webterm__skill_list', 'mcp__webterm__skill_load', 'mcp__webterm__skill_propose'])
    // Still the locked-down shell: no built-ins, deny-by-default, no prompts.
    expect(o).toMatchObject({ tools: [], strictMcpConfig: true, permissionMode: 'dontAsk', permissionPrompts: 'none', settingSources: [] })
  })

  it('names the target skill in an edit chat', () => {
    const o = centralQueryOptions({ ...base, mode: 'skill-author', skillTarget: 'webterm-project-status' })
    expect(system(o)).toBe(modePrompt('skill-author', 'webterm-project-status'))
    expect(system(o)).toContain('webterm-project-status')
  })

  it('leaves the steward options byte-identical when there is no mode', () => {
    const o = centralQueryOptions(base)
    expect(system(o)).toBe(CENTRAL_STEWARD_PROMPT)
    expect(o.allowedTools).toEqual(['mcp__webterm__*'])
    expect(centralQueryOptions({ ...base, mode: undefined })).toEqual(o)
  })
})
