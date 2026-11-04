import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { buildContext, describeEvent, groupEvents, matchesFilter, mergeEvents, NO_FILTER, type TimelineEvent } from './Timeline.model'
import { effectiveLevel, parseControl, parseIntegrity } from './Timeline.status'

// test-only fixtures
const ws = (id: string, name: string, cwd: string, nodes: Array<{ id: string; title: string }>): Workspace => ({
  id, name, cwd, viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: nodes.map((n) => ({ ...n, kind: 'terminal' as const, x: 0, y: 0 })),
})
const WS = [
  ws('w1', 'Webterm', '/repo/webterm', [{ id: 'n1', title: 'brisk-otter' }, { id: 'b1', title: 'makuro-browser' }]),
  ws('w2', 'Other', '/repo/other', [{ id: 'n2', title: 'calm-heron' }]),
]
const ctx = buildContext(WS)
let seq = 0
const ev = (kind: string, patch: Partial<TimelineEvent> = {}): TimelineEvent => ({
  seq: ++seq, ts: 1000 + seq, kind, source: 'test', actor: 'test', subject: null, workspaceId: null, nodeId: null,
  trust: 'trusted', dedupeKey: null, payload: null, prevHash: '', hash: '', ...patch,
})

describe('describeEvent', () => {
  it('words hook, pty, fs and edge events for humans', () => {
    expect(describeEvent(ev('hook.Stop', { nodeId: 'n1' }), ctx)).toEqual({ text: 'brisk-otter finished a turn', focusId: 'n1' })
    expect(describeEvent(ev('hook.PreToolUse', { nodeId: 'n1', payload: { toolName: 'Bash' } }), ctx).text).toBe('brisk-otter is running Bash')
    expect(describeEvent(ev('pty.exit', { nodeId: 'n2', payload: { code: 1, reason: 'self' } }), ctx).text).toBe('calm-heron exited (code 1)')
    expect(describeEvent(ev('fs.change', { payload: { dir: '/repo/webterm/src', names: ['a', 'b'], more: 10 } }), ctx))
      .toEqual({ text: 'File changes in src/ (12)', focusId: null })
    const edge = ev('edge.change', { workspaceId: 'w1', payload: { changes: [{ nodeId: 'n1', added: ['b1'], removed: [], renamed: [] }, { nodeId: 'b1', added: ['n1'], removed: [], renamed: [] }] } })
    expect(describeEvent(edge, ctx)).toEqual({ text: 'Cable: brisk-otter ↔ makuro-browser connected', focusId: 'n1' })
    expect(describeEvent(ev('hook.Stop', { nodeId: 'gone-node-123456' }), ctx).text).toBe('gone-nod finished a turn')
  })
})

describe('groupEvents', () => {
  it('task mode opens a group per turn and closes it on Stop; collapses repeats', () => {
    const groups = groupEvents([
      ev('hook.UserPromptSubmit', { nodeId: 'n1', payload: { preview: 'fix the bug' } }),
      ev('hook.PreToolUse', { nodeId: 'n1', payload: { toolName: 'Bash' } }),
      ev('hook.PreToolUse', { nodeId: 'n1', payload: { toolName: 'Bash' } }),
      ev('hook.Stop', { nodeId: 'n1' }),
      ev('hook.UserPromptSubmit', { nodeId: 'n1' }),
    ], 'task', ctx)
    expect(groups.map((g) => [g.label, g.running])).toEqual([['brisk-otter: turn', true], ['brisk-otter: fix the bug', false]])
    expect(groups[1]!.lines.map((l) => [l.text, l.count])).toEqual([
      ['brisk-otter received a prompt', 1], ['brisk-otter is running Bash', 2], ['brisk-otter finished a turn', 1],
    ])
  })

  it('node and workspace modes key by node / resolved workspace (fs by cwd)', () => {
    const list = [ev('hook.Stop', { nodeId: 'n1' }), ev('hook.Stop', { nodeId: 'n2' }), ev('fs.change', { payload: { dir: '/repo/other/x', names: ['f'] } })]
    expect(groupEvents(list, 'node', ctx).map((g) => g.label)).toEqual(['Other', 'calm-heron', 'brisk-otter'])
    expect(groupEvents(list, 'workspace', ctx).map((g) => [g.label, g.lines.length])).toEqual([['Other', 2], ['Webterm', 1]])
  })
})

it('matchesFilter applies workspace, kind and agent', () => {
  const a = ev('hook.Stop', { nodeId: 'n1' })
  const f = ev('fs.change', { payload: { dir: '/repo/other', names: [] } })
  expect(matchesFilter(a, { ...NO_FILTER, workspaceId: 'w1' }, ctx)).toBe(true)
  expect(matchesFilter(f, { ...NO_FILTER, workspaceId: 'w1' }, ctx)).toBe(false)
  expect(matchesFilter(f, { ...NO_FILTER, kind: 'fs' }, ctx)).toBe(true)
  expect(matchesFilter(a, { ...NO_FILTER, kind: 'fs' }, ctx)).toBe(false)
  expect(matchesFilter(a, { ...NO_FILTER, nodeId: 'n2' }, ctx)).toBe(false)
})

it('mergeEvents dedupes by seq, keeps order and the cap', () => {
  const [a, b, c] = [ev('x.a'), ev('x.b'), ev('x.c')]
  expect(mergeEvents([b!], [a!, b!, c!], 10).map((e) => e.kind)).toEqual(['x.a', 'x.b', 'x.c'])
  expect(mergeEvents([a!, b!], [c!], 2).map((e) => e.kind)).toEqual(['x.b', 'x.c'])
})

it('effectiveLevel is the lowest of ceiling, global and own level', () => {
  const s = parseControl({ ceiling: 'act_envelope', global: { level: 'act_gated' }, projects: [{ scope: 'project:w1', level: 'observe' }] })!
  expect(effectiveLevel(s, 'w1')).toBe('observe')
  expect(effectiveLevel(s, 'w2')).toBe('act_gated')
  expect(parseControl({ error: 'nope' })).toBeNull()
})

it('parseIntegrity: ok, broken chain, diverged anchor, unknown', () => {
  expect(parseIntegrity({ head: { seq: 5 }, anchorStatus: 'match', startStatus: 'match', verify: { ok: true } })).toEqual({ state: 'ok', seq: 5 })
  expect(parseIntegrity({ verify: { ok: false, brokenAt: { seq: 3, reason: 'hash_mismatch' } } }))
    .toEqual({ state: 'warning', reason: 'Event chain broken at #3 (hash_mismatch)' })
  expect(parseIntegrity({ anchorStatus: 'match', startStatus: 'rewritten', verify: { ok: true } }).state).toBe('warning')
  expect(parseIntegrity({})).toEqual({ state: 'unknown' })
})
