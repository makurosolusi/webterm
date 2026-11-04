import { describe, expect, it } from 'vitest'
import { createDoomLoopGuard, permissionDecision, preToolDeny, suggestedPattern, toolLabel } from './permission.model'

describe('PermissionRequest reply shape (code.claude.com/docs/en/hooks)', () => {
  it('allow carries only behavior', () => {
    expect(permissionDecision('allow', 'ignored')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })
  it('deny carries the message for Claude', () => {
    expect(permissionDecision('deny', 'no')).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } })
  })
  it('PreToolUse block uses permissionDecision deny + reason', () => {
    expect(preToolDeny('loop')).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'loop' })
  })
})

describe('labels and patterns', () => {
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra })
  it('labels a Bash call and scrubs secrets from the preview', () => {
    expect(toolLabel(bash('npm publish'))).toBe('Bash(npm publish)')
    expect(toolLabel(bash('curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123"'))).not.toContain('abcdefghijklmnop')
  })
  it("prefers Claude's own suggestion, turning cmd:* into cmd*", () => {
    const body = bash('npm run test -- --watch', { permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }] }] })
    expect(suggestedPattern(body)).toBe('npm run test*')
  })
  it('falls back to the exact command, and refuses one holding wildcards', () => {
    expect(suggestedPattern(bash('npm publish'))).toBe('npm publish')
    expect(suggestedPattern(bash('rm *'))).toBeNull()
    expect(suggestedPattern({ tool_name: 'WebSearch', tool_input: {} })).toBe('*')
  })
})

describe('doom-loop guard', () => {
  it('trips on the 3rd identical consecutive call only', () => {
    const g = createDoomLoopGuard(3, 60_000)
    const call = { tool_name: 'Bash', tool_input: { command: 'ls' } }
    expect(g.check('n1', call, 0)).toBe(0)
    expect(g.check('n1', call, 1)).toBe(0)
    expect(g.check('n1', call, 2)).toBe(3)
    expect(g.check('n2', call, 3)).toBe(0) // other node: own counter
  })
  it('resets on a different call or outside the window', () => {
    const g = createDoomLoopGuard(3, 1000)
    const a = { tool_name: 'Bash', tool_input: { command: 'ls' } }
    const b = { tool_name: 'Bash', tool_input: { command: 'pwd' } }
    g.check('n', a, 0); g.check('n', a, 1); g.check('n', b, 2)
    expect(g.check('n', a, 3)).toBe(0)
    g.check('n', a, 4)
    expect(g.check('n', a, 5000)).toBe(0)
  })
})
