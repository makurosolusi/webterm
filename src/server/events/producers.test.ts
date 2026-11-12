// Senses producers (F1-d) in node-env: no ledger here, so every event takes the unrecorded bus path
// (`recordEvent` fallback) — which is exactly what the in-process subscribers (linkNote, wake) see.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import { eventBus } from './eventBus'
import type { SenseEvent } from './eventModel'
import { FS_EVENT_DEBOUNCE_MS, produceFsChange, produceHookEvent, producePtyExit } from './producers'
import { edgeChanges, produceEdgeChange } from './producers.edge'

let off: (() => void) | null = null
afterEach(() => { off?.(); off = null; vi.useRealTimers() })

function capture(pattern = '*'): SenseEvent[] {
  const seen: SenseEvent[] = []
  off = eventBus.subscribe(pattern, (e) => { seen.push(e) })
  return seen
}

const ws = (bridges: Workspace['bridges'], browserTitle = 'Browser'): Workspace => ({
  id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges,
  nodes: [
    { id: 'a1', kind: 'agent', agentId: 'claude', title: 'Claude' },
    { id: 'web1', kind: 'browser', title: browserTitle },
  ],
} as unknown as Workspace)
const wire = [{ id: 'b', source: 'a1', target: 'web1', kind: 'context' }] as unknown as Workspace['bridges']

describe('produceHookEvent', () => {
  it('records hook.<Event>, trusted with the node token, with a redacted short preview only', () => {
    const seen = capture('hook.*')
    const secret = 'sk-' + 'A'.repeat(30) // test-only fake key
    produceHookEvent({
      nodeId: 'a1', workspaceId: 'w1', status: 'waiting', verified: true,
      body: {
        hook_event_name: 'Notification', notification_type: 'agent_needs_input',
        message: `use ${secret}\nnow ${'x'.repeat(500)}`, session_id: 'sess-123', tool_input: { command: 'rm -rf' },
      },
    })
    expect(seen).toHaveLength(1)
    const e = seen[0]
    expect(e).toMatchObject({ kind: 'hook.Notification', source: 'agentStatusApi', nodeId: 'a1', workspaceId: 'w1', trust: 'trusted' })
    const p = e.payload as Record<string, unknown>
    expect(p.status).toBe('waiting')
    expect(p.notificationType).toBe('agent_needs_input')
    const preview = String(p.preview)
    expect(preview).not.toContain(secret)
    expect(preview).toContain('[redacted]')
    expect(preview).not.toContain('\n')
    expect(preview.length).toBeLessThanOrEqual(121)
    const json = JSON.stringify(p)
    expect(json).not.toContain('sess-123')
    expect(json).not.toContain('rm -rf')
  })

  it('tool hooks keep the redacted, capped command or path, the session mode and (PostToolUse) the outcome', () => {
    const seen = capture('hook.*')
    const secret = 'sk-' + 'B'.repeat(30) // test-only fake key
    produceHookEvent({ nodeId: 'a1', workspaceId: 'w1', status: null, verified: true, mode: 'danger', body: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "x: ${secret}" ${'y'.repeat(400)}`, description: 'private body' } } })
    produceHookEvent({ nodeId: 'a1', workspaceId: 'w1', status: null, verified: true, mode: 'ask', body: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts', new_string: 'body' }, tool_response: { success: true } } })
    produceHookEvent({ nodeId: 'a1', workspaceId: 'w1', status: null, verified: true, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { is_error: true } } })
    const [pre, post, failed] = seen.map((e) => e.payload as Record<string, unknown>)
    expect(String(pre.input)).toContain('curl -H')
    expect(String(pre.input)).not.toContain(secret)
    expect(String(pre.input).length).toBeLessThanOrEqual(201)
    expect(JSON.stringify(pre)).not.toContain('private body')
    expect(pre).toMatchObject({ mode: 'danger', toolName: 'Bash' })
    expect(pre.outcome).toBe(undefined)
    expect(post).toMatchObject({ input: '/repo/a.ts', mode: 'ask', outcome: 'ok' })
    expect(JSON.stringify(post)).not.toContain('body')
    expect(failed).toMatchObject({ outcome: 'error' })
    expect(failed.mode).toBe(undefined)
  })

  it('a hook without this node\'s token is untrusted; a malformed event name is skipped', () => {
    const seen = capture('hook.*')
    produceHookEvent({ nodeId: 'a1', status: null, verified: false, body: { hook_event_name: 'Stop' } })
    produceHookEvent({ nodeId: 'a1', status: null, verified: true, body: { hook_event_name: 'a.b c' } })
    produceHookEvent({ nodeId: 'a1', status: null, verified: true, body: {} })
    expect(seen.map((e) => [e.kind, e.trust])).toEqual([['hook.Stop', 'untrusted']])
  })
})

describe('producePtyExit', () => {
  it('records pty.exit (trusted) with code and reason', () => {
    const seen = capture('pty.exit')
    producePtyExit({ nodeId: 'n1', agentId: 'claude', code: 2, reason: 'self', durationMs: 50 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'pty.exit', source: 'pty', nodeId: 'n1', trust: 'trusted', payload: { code: 2, reason: 'self', agentId: 'claude', durationMs: 50 } })
  })
})

describe('produceFsChange', () => {
  it('debounces per directory into one untrusted fs.change with the names seen', () => {
    vi.useFakeTimers()
    const seen = capture('fs.change')
    produceFsChange('/tmp/proj', ['a.ts'])
    produceFsChange('/tmp/proj', ['b.ts', 'a.ts'])
    vi.advanceTimersByTime(FS_EVENT_DEBOUNCE_MS - 1)
    expect(seen).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'fs.change', source: 'fsWatch', trust: 'untrusted', subject: 'path:/tmp/proj', payload: { dir: '/tmp/proj', names: ['a.ts', 'b.ts'], more: 0, cause: 'unknown' } })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('edge.change', () => {
  it('diffs added, renamed and removed peers per node', () => {
    expect(edgeChanges(ws([]), ws(wire)).find((c) => c.nodeId === 'a1')).toEqual({ nodeId: 'a1', added: ['web1'], removed: [], renamed: [] })
    expect(edgeChanges(ws(wire), ws(wire, 'Docs')).find((c) => c.nodeId === 'a1')).toEqual({ nodeId: 'a1', added: [], removed: [], renamed: ['web1'] })
    expect(edgeChanges(ws(wire), ws([])).find((c) => c.nodeId === 'a1')).toEqual({ nodeId: 'a1', added: [], removed: ['web1'], renamed: [] })
    expect(edgeChanges(ws(wire), ws(wire))).toEqual([])
  })

  it('a save that changes a cable records one trusted edge.change; an unchanged save records nothing', () => {
    const seen = capture('edge.change')
    produceEdgeChange(ws(wire), ws(wire))
    expect(seen).toHaveLength(0)
    produceEdgeChange(ws([]), ws(wire))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'edge.change', source: 'workspacesApi', actor: 'human-ui', workspaceId: 'w1', trust: 'trusted' })
    expect((seen[0].payload as { changes: Array<{ nodeId: string }> }).changes.some((c) => c.nodeId === 'a1')).toBe(true)
  })

  it('a malformed node list never throws into the save path', () => {
    const bad = { ...ws(wire), nodes: [null] } as unknown as Workspace
    expect(() => produceEdgeChange(ws([]), bad)).not.toThrow()
  })
})
