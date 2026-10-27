import { describe, expect, it } from 'vitest'
import { buildClaudeFlags, claudeHooksSettings, hookStatus } from './hooks'

describe('hookStatus', () => {
  it('maps activity events to working', () => {
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      expect(hookStatus({ hook_event_name: e })).toBe('working')
    }
  })
  it('maps Stop to waiting', () => {
    expect(hookStatus({ hook_event_name: 'Stop' })).toBe('waiting')
  })
  it('maps a permission Notification to blocked', () => {
    expect(hookStatus({ hook_event_name: 'Notification', message: 'Claude needs your permission to run Bash' })).toBe('blocked')
  })
  it('maps a non-permission Notification to waiting', () => {
    expect(hookStatus({ hook_event_name: 'Notification', message: 'still here if you need me' })).toBe('waiting')
  })
  it('maps SessionEnd to done', () => {
    expect(hookStatus({ hook_event_name: 'SessionEnd' })).toBe('done')
  })
  it('returns null for an unknown event', () => {
    expect(hookStatus({ hook_event_name: 'Nope' })).toBeNull()
  })
})

describe('claudeHooksSettings', () => {
  it('has all 7 event keys, each a non-empty array with a keyed command', () => {
    const s = claudeHooksSettings('n1', 8700)
    const hooks = s.hooks as Record<string, unknown[]>
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']
    for (const e of events) {
      expect(Array.isArray(hooks[e])).toBe(true)
      expect(hooks[e].length).toBeGreaterThan(0)
      const cmd = (hooks[e][0] as { hooks: { command: string }[] }).hooks[0].command
      expect(cmd).toContain('node=n1')
      expect(cmd).toContain('127.0.0.1:8700')
    }
  })
})

describe('buildClaudeFlags', () => {
  it('uses --session-id for a fresh session', () => {
    const f = buildClaudeFlags('n1', 'uuid-x', 8700, false)
    expect(f).toContain('--session-id uuid-x')
    expect(f).toContain("--settings '")
  })
  it('uses --resume when resuming, not --session-id', () => {
    const f = buildClaudeFlags('n1', 'uuid-x', 8700, true)
    expect(f).toContain('--resume uuid-x')
    expect(f).not.toContain('--session-id')
  })
})
