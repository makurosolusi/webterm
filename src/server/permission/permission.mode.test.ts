import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { effectiveClaudeMode, launchModeFor } from './permission.mode'

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

describe('launchModeFor with the default settings (Bypass since 2026-11-17)', () => {
  it('a new terminal or Agent Chat node without a mode of its own launches in bypassPermissions', () => {
    expect(launchModeFor(DEFAULT_SETTINGS, null)).toBe('bypassPermissions')
    expect(launchModeFor(DEFAULT_SETTINGS, 'w1', undefined)).toBe('bypassPermissions')
  })

  it('an explicit per-project Ask or Auto override is still honoured', () => {
    const s = { ...DEFAULT_SETTINGS, projectApprovalLevels: { w1: 'always', w2: 'risky' } } as const
    expect(launchModeFor(s, 'w1')).toBe('manual')
    expect(launchModeFor(s, 'w2')).toBe('auto')
    expect(launchModeFor(s, 'w3')).toBe('bypassPermissions')
  })
})
