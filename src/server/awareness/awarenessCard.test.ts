// Identifier card: built from the workspace + bus events, cached, and dropped only by the events that change it.
import { describe, expect, it } from 'vitest'
import type { Workspace } from '../../shared/workspace'
import { createEventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { CARD_MAX_CHARS, CARD_MAX_LISTED, createAwarenessCards } from './awarenessCard'

function board(): Workspace {
  return {
    id: 'w1', name: 'My Board', cwd: '/home/u/proj', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
    nodes: [
      { id: 'a1', kind: 'agent', x: 0, y: 0, title: 'Claude main', agentId: 'claude' },
      { id: 'web1', kind: 'browser', x: 0, y: 0, title: 'Docs browser' },
      { id: 'peer1', kind: 'agent', x: 0, y: 0, title: 'Reviewer', agentId: 'claude' },
      { id: 'd1', kind: 'diff', x: 0, y: 0, title: 'Changes' },
      { id: 'lonely', kind: 'agent', x: 0, y: 0, title: 'Unwired' },
    ],
    bridges: [
      { id: 'b1', source: 'a1', target: 'web1' },
      { id: 'b2', source: 'peer1', target: 'a1' },
      { id: 'b3', source: 'a1', target: 'd1' },
    ],
  } as unknown as Workspace
}

let seq = 0
const ev = (kind: string, over: Partial<SenseEvent> = {}): SenseEvent => ({
  seq: ++seq, ts: 0, kind, source: 'test', actor: 'test', subject: null, workspaceId: null, nodeId: null,
  trust: 'trusted', dedupeKey: null, payload: null, prevHash: '', hash: '', ...over,
})

describe('awareness card', () => {
  it('renders identity, wired peers with status, browsers and diffs', () => {
    const bus = createEventBus()
    const cards = createAwarenessCards(bus)
    bus.publish(ev('hook.Stop', { nodeId: 'peer1', payload: { status: 'done' } }))
    const text = cards.card('a1', board())
    expect(text).toContain('node "Claude main" (id a1) on board "My Board", cwd /home/u/proj.')
    expect(text).toContain('Wired peers: "Reviewer" (id peer1, claude, done)')
    expect(text).toContain('Wired browsers: "Docs browser" (id web1)')
    expect(text).toContain('Wired diffs: "Changes" (id d1)')
    expect(cards.card('lonely', board())).not.toContain('Wired')
    cards.dispose()
  })

  it('is cached across hooks and rebuilt only by an invalidating event', () => {
    const bus = createEventBus()
    const cards = createAwarenessCards(bus)
    cards.card('a1', board())
    cards.card('a1', board())
    bus.publish(ev('hook.PreToolUse', { nodeId: 'peer1', payload: {} })) // no status → no change
    bus.publish(ev('hook.Stop', { nodeId: 'lonely', payload: { status: 'done' } })) // not a peer of a1
    bus.publish(ev('edge.change', { workspaceId: 'other' }))
    expect(cards.card('a1', board())).not.toContain('working')
    expect(cards.builds).toBe(1)

    bus.publish(ev('hook.UserPromptSubmit', { nodeId: 'peer1', payload: { status: 'working' } }))
    expect(cards.card('a1', board())).toContain('(id peer1, claude, working)')
    expect(cards.builds).toBe(2)

    bus.publish(ev('pty.exit', { nodeId: 'peer1' }))
    expect(cards.card('a1', board())).toContain('(id peer1, claude, exited)')
    expect(cards.builds).toBe(3)

    const unwired = board()
    unwired.bridges = unwired.bridges.filter((b) => b.id !== 'b1')
    bus.publish(ev('edge.change', { workspaceId: 'w1' }))
    expect(cards.card('a1', unwired)).not.toContain('Docs browser')
    expect(cards.builds).toBe(4)
    cards.dispose()
  })

  it('an own rename (no bus event) is caught by the identity signature', () => {
    const cards = createAwarenessCards(createEventBus())
    cards.card('a1', board())
    const renamed = board()
    renamed.nodes[0]!.title = 'Renamed'
    expect(cards.card('a1', renamed)).toContain('node "Renamed"')
    cards.dispose()
  })

  it('caps each list and the whole card', () => {
    const ws = board()
    for (let i = 0; i < 40; i++) {
      ws.nodes.push({ id: `p${i}`, kind: 'agent', x: 0, y: 0, title: 'x'.repeat(100) } as Workspace['nodes'][number])
      ws.bridges.push({ id: `bb${i}`, source: 'a1', target: `p${i}` } as Workspace['bridges'][number])
    }
    const text = createAwarenessCards(createEventBus()).card('a1', ws)
    expect(text.length).toBeLessThanOrEqual(CARD_MAX_CHARS)
    expect(text).toContain(`+${41 - CARD_MAX_LISTED} more`)
  })
})
