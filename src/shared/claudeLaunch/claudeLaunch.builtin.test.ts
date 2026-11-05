import { describe, expect, it } from 'vitest'
import { claudeProfileLine, isLegacyClaudeNode, resolveClaudeProfileIn } from './claudeLaunch.builtin'

const S = { claudeLaunchProfiles: [{ id: 'm', name: 'M', command: `envman -e 'a b' --` }], defaultClaudeProfileId: 'm' }

describe('builtin claude launch from profiles', () => {
  it('resolves the default profile of partial settings; no profile fields = Default', () => {
    expect(claudeProfileLine(S)).toBe(`envman -e 'a b' -- claude`)
    expect(claudeProfileLine({})).toBe('claude')
    expect(resolveClaudeProfileIn({}).profile.id).toBe('default')
  })

  it('recognises only a profile-less claude node with the stock command as legacy', () => {
    expect(isLegacyClaudeNode({ agentId: 'claude', cmd: 'claude' })).toBe(true)
    expect(isLegacyClaudeNode({ agentId: 'claude', cmd: ' claude ' })).toBe(true)
    expect(isLegacyClaudeNode({ agentId: 'claude', cmd: 'claude', claudeProfileId: 'm' })).toBe(false)
    expect(isLegacyClaudeNode({ agentId: 'claude', cmd: 'envman -e x -- claude' })).toBe(false)
    expect(isLegacyClaudeNode({ agentId: 'claude' })).toBe(false)
    expect(isLegacyClaudeNode({ agentId: 'codex', cmd: 'claude' })).toBe(false)
  })
})
