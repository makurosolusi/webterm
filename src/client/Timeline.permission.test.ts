import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { buildContext, describeEvent, groupEvents, matchesFilter, NO_FILTER, type TimelineEvent } from './Timeline.model'

// test-only fixtures
const WS: Workspace[] = [{
  id: 'w1', name: 'Webterm', cwd: '/repo/webterm', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'brisk-otter' }],
}, {
  id: 'w2', name: 'Other', cwd: '/repo/other', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'n2', kind: 'terminal', x: 0, y: 0, title: 'calm-heron' }],
}]
const ctx = buildContext(WS)
let seq = 0
const ev = (kind: string, payload: Record<string, unknown> | null, patch: Partial<TimelineEvent> = {}): TimelineEvent => ({
  seq: ++seq, ts: 1000 + seq, kind, source: 'test', actor: 'test', subject: null, workspaceId: null, nodeId: 'n1',
  trust: 'trusted', dedupeKey: null, payload, prevHash: '', hash: '', ...patch,
})
const say = (kind: string, payload: Record<string, unknown> | null, patch: Partial<TimelineEvent> = {}) => {
  const d = describeEvent(ev(kind, payload, patch), ctx)
  return d.tone ? [d.text, d.tone] : [d.text]
}

describe('tool lines', () => {
  it('show input, mode and outcome when present', () => {
    expect(say('hook.PreToolUse', { toolName: 'Bash', input: 'rm -rf dist', mode: 'danger' })).toEqual(['brisk-otter skipped asking (Danger): Bash rm -rf dist', 'warning'])
    expect(say('hook.PreToolUse', { toolName: 'Edit', input: 'src/x.ts', mode: 'auto' })).toEqual(['brisk-otter is running Edit src/x.ts (Auto)'])
    expect(say('hook.PreToolUse', { toolName: 'Read', input: 'a.md', mode: 'ask' })).toEqual(['brisk-otter is running Read a.md'])
    expect(say('hook.PostToolUse', { toolName: 'Bash', input: 'ls', outcome: 'error' })).toEqual(['brisk-otter ran Bash ls (failed)'])
    expect(say('hook.PostToolUse', { toolName: 'Bash', input: 'ls', outcome: 'ok' })).toEqual(['brisk-otter ran Bash ls'])
  })
  it('fall back for old events without the new fields', () => {
    expect(say('hook.PreToolUse', { toolName: 'Bash' })).toEqual(['brisk-otter is running Bash'])
    expect(say('hook.PostToolUse', { toolName: 'Bash' })).toEqual(['brisk-otter ran Bash'])
    expect(say('hook.PostToolUseFailure', { toolName: 'Bash', input: 'npm test', outcome: 'error' })).toEqual(['brisk-otter ran Bash npm test (failed)'])
    expect(say('hook.PermissionRequest', { toolName: 'Bash', input: 'git push' })).toEqual(['brisk-otter asks permission for Bash git push'])
    expect(say('hook.PermissionRequest', {})).toEqual(['brisk-otter asks permission for a tool'])
    expect(say('hook.PreToolUse', null)).toEqual(['brisk-otter is running a tool'])
  })
})

describe('permission lines', () => {
  const label = 'Bash(rm -rf dist)'
  it('permission.request and every permission.decision path', () => {
    expect(say('permission.request', { tool: 'Bash', label, approvalId: 'a1' })).toEqual([`Waiting for you: ${label}`])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'allow', by: 'human-ui' })).toEqual([`Approved by you: ${label}`])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'deny', by: 'human-ui', mode: 'auto' })).toEqual([`Denied by you: ${label}`])
    expect(say('permission.decision', { tool: 'Edit', label: 'Edit(src/x.ts)', behavior: 'allow', by: 'classifier' })).toEqual(['Auto-allowed: Edit(src/x.ts)'])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'deny', by: 'rule', ruleId: 'r1' })).toEqual([`Blocked by your rule: ${label}`])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'allow', by: 'rule', ruleId: 'r1' })).toEqual([`Allowed by your rule: ${label}`])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'allow', by: 'rule', skipped: true, mode: 'danger' })).toEqual([`Skipped asking (Danger): ${label}`, 'warning'])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'none', by: 'timeout' })).toEqual([`No answer in time, asked in the terminal: ${label}`])
    expect(say('permission.decision', { tool: 'Bash', label, behavior: 'none', by: 'hook_closed' })).toEqual([`Request closed before an answer: ${label}`])
    // Old/odd payloads still read as a sentence.
    expect(say('permission.decision', { tool: 'Bash' })).toEqual(['Approved by you: Bash'])
    expect(say('permission.request', null)).toEqual(['Waiting for you: a tool'])
  })
  it('doom loop and mode changes', () => {
    expect(say('permission.doom_loop', { label, count: 3, behavior: 'deny' })).toEqual([`Stopped a repeat loop: ${label} (3 times)`, 'warning'])
    expect(say('permission.mode_change', { actor: 'human-ui', scope: 'workspace', workspaceId: 'w1', from: 'risky', to: 'never' }, { nodeId: null, workspaceId: 'w1' }))
      .toEqual(['Mode changed: Auto → Danger (this project)', 'warning'])
    expect(say('permission.mode_change', { actor: 'human-ui', scope: 'global', from: 'never', to: 'always' }, { nodeId: null })).toEqual(['Mode changed: Danger → Ask (all projects)'])
    expect(say('permission.mode_change', { scope: 'node', from: 'manual', to: 'acceptEdits' })).toEqual(['Mode changed: Ask → Accept edits (this agent)'])
    expect(say('permission.mode_change', { scope: 'node', from: null, to: 'plan' })).toEqual(['Mode changed to Plan (this agent)'])
  })
  it('central.guard verdicts', () => {
    const g = (p: Record<string, unknown>) => say('central.guard', { action: 'run', tool: 'shell.exec', tier: 'R2', level: 'act_gated', ...p }, { nodeId: null, workspaceId: 'w1' })
    expect(g({ verdict: 'allow' })).toEqual(['Central allowed: shell.exec'])
    expect(g({ verdict: 'allow', skipped: true })).toEqual(['Skipped asking (Danger): Central shell.exec', 'warning'])
    expect(g({ verdict: 'needs_approval' })).toEqual(['Central asked you: shell.exec'])
    expect(g({ verdict: 'deny', code: 'level_denied', reason: 'level observe is below act_gated' })).toEqual(['Central was blocked: shell.exec (level observe is below act_gated)'])
    expect(g({ verdict: 'deny', rule: 'r9' })).toEqual(['Blocked by your rule: Central shell.exec'])
  })
  it('policy events', () => {
    expect(say('policy.classifier', { capability: 'claude.tool:Bash', effect: 'allow', by: 'classifier', reason: 'read-only' })).toEqual(['Auto-allowed: Bash (read-only)'])
    expect(say('policy.classifier', { capability: 'claude.tool:Bash', effect: 'ask', by: 'never_auto', reason: 'destructive' })).toEqual(['Auto-review asked you: Bash (destructive)'])
    expect(say('policy.classifier_switch', { central: true, permissions: false }, { nodeId: null })).toEqual(['Auto-review: Central on, permission prompts off'])
    expect(say('policy.decision', { capability: 'fs.write', effect: 'deny', reason: 'outside project' })).toEqual(['Blocked by policy: fs.write (outside project)'])
    expect(say('policy.grant', { capability: 'fs.write' })).toEqual(['Policy: grant fs.write'])
  })
})

it('the Permissions kind covers all three families and composes with node and workspace filters', () => {
  const list = [
    ev('permission.decision', { label: 'Bash', behavior: 'allow', by: 'human-ui' }, { workspaceId: 'w1' }),
    ev('central.guard', { tool: 'x', verdict: 'allow' }, { nodeId: null, workspaceId: 'w2' }),
    ev('policy.classifier', { capability: 'claude.tool:Edit', effect: 'allow' }, { nodeId: 'n2' }),
    ev('hook.Stop', null),
    ev('central.turn', null),
  ]
  const kinds = (f: typeof NO_FILTER) => list.filter((e) => matchesFilter(e, f, ctx)).map((e) => e.kind)
  expect(kinds({ ...NO_FILTER, kind: 'permissions' })).toEqual(['permission.decision', 'central.guard', 'policy.classifier'])
  expect(kinds({ ...NO_FILTER, kind: 'permissions', nodeId: 'n2' })).toEqual(['policy.classifier'])
  expect(kinds({ ...NO_FILTER, kind: 'permissions', workspaceId: 'w2' })).toEqual(['central.guard', 'policy.classifier'])
  expect(kinds({ ...NO_FILTER, kind: 'hook' })).toEqual(['hook.Stop'])
  // Tone survives grouping onto the rendered line.
  const lines = groupEvents([ev('permission.doom_loop', { label: 'Bash', count: 2 })], 'node', ctx)[0]!.lines
  expect(lines[0]!.tone).toBe('warning')
})
