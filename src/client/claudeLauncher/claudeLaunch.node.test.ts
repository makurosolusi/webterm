import { describe, expect, it } from 'vitest'
import { recordedClaudeProfile } from './claudeLaunch.node'
import { toFlow, toWsNode } from '../store'

describe('node launch profile recording', () => {
  it('builtin claude records the default profile; other agents record nothing', () => {
    expect(recordedClaudeProfile('claude', 'm')).toEqual({ claudeProfileId: 'm' })
    expect(recordedClaudeProfile('codex', 'm')).toEqual({})
    expect(recordedClaudeProfile('custom:x', 'm')).toEqual({})
  })
  it('the recorded id survives the save/load round trip', () => {
    const n = { id: 'n1', kind: 'agent' as const, x: 0, y: 0, agentId: 'claude' as const, cmd: 'claude', claudeProfileId: 'm' }
    expect(toWsNode(toFlow(n)).claudeProfileId).toBe('m')
  })
})
