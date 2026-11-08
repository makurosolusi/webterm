import { describe, expect, it } from 'vitest'
import { effectiveClaudeMode } from './permission.mode'

describe('effectiveClaudeMode', () => {
  it('skip on forces bypassPermissions whatever the settings or node mode', () => {
    expect(effectiveClaudeMode('auto', undefined, true)).toBe('bypassPermissions')
    expect(effectiveClaudeMode('manual', 'plan', true)).toBe('bypassPermissions')
  })

  it('skip off: the node mode wins, else the settings default', () => {
    expect(effectiveClaudeMode('auto', undefined, false)).toBe('auto')
    expect(effectiveClaudeMode('manual', 'plan', false)).toBe('plan')
    expect(effectiveClaudeMode('acceptEdits', undefined, false)).toBe('acceptEdits')
  })
})
