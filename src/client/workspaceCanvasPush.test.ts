// A server canvas push (`t:'canvas'`) while this window holds unsent saves: the next save carries
// the pushed nodes (and lacks the removed ones) and is based on the push's version (no 409, no
// dropped edit, no resurrected node), and the mounted board applies them live.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasMsg } from '../shared/protocol'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { connectTabLayout, getTabLayout } from './tabLayout.store'
import { createSaveQueue } from './workspaceSaveQueue'
import { mergeCanvasPush } from './workspaceCanvasMerge'
import { applyCanvasPush, type LiveBoard } from './workspaceCanvasPush'

const AGENT: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0 }
const BROWSER: WsNode = { id: 'b1', kind: 'browser', url: 'https://example.com', x: 432, y: 0 }
const CABLE = { id: 'bridge-agent-1-b1', source: 'agent-1', target: 'b1', kind: 'context' as const }
const board = (updatedAt: number, name = 'w', nodes: WsNode[] = [AGENT]): Workspace =>
  ({ id: 'w1', name, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt }) // test-only
const httpError = (status: number, body?: unknown) => Object.assign(new Error(`PUT -> ${status}`), { status, body })

/** One versioned row with `Db.save`'s precondition; `hooks` run once while a save is in flight. */
function fakeServer(start: Workspace) {
  let stored = start
  const sent: number[] = []
  const hooks: { before?: () => void; after?: () => void } = {}
  const save = vi.fn(async (ws: Workspace) => {
    sent.push(ws.updatedAt)
    await Promise.resolve()
    const before = hooks.before
    hooks.before = undefined
    before?.()
    if (stored.updatedAt > ws.updatedAt) throw httpError(409, { code: 'stale', current: stored })
    stored = { ...ws, updatedAt: stored.updatedAt + 1 }
    const answer = stored
    const after = hooks.after
    hooks.after = undefined
    after?.()
    return answer
  })
  /** The server-side push: stores the browser + cable on top of the current row, returns the frame. */
  const push = (): CanvasMsg => {
    const base = stored.updatedAt
    stored = mergeCanvasPush({ ...stored, updatedAt: base + 1 }, { nodes: [BROWSER], bridges: [CABLE] })
    return { t: 'canvas', workspaceId: stored.id, base, updatedAt: stored.updatedAt, nodes: [BROWSER], bridges: [CABLE] }
  }
  /** The server-side remove: drops `ids` and their cables from the current row, returns the frame. */
  const remove = (ids: string[]): CanvasMsg => {
    const base = stored.updatedAt
    stored = mergeCanvasPush({ ...stored, updatedAt: base + 1 }, { nodes: [], bridges: [], removed: ids })
    return { t: 'canvas', workspaceId: stored.id, base, updatedAt: stored.updatedAt, nodes: [], bridges: [], removed: ids }
  }
  return { save, sent, hooks, push, remove, get: () => stored, set: (ws: Workspace) => { stored = ws } }
}

const setup = (start = board(10)) => {
  const srv = fakeServer(start)
  const hooks = { onStale: vi.fn(), onMissing: vi.fn() }
  return { srv, hooks, q: createSaveQueue(hooks, { save: srv.save }) }
}

describe('save queue absorbs a canvas push', () => {
  it('a push on an untouched board: the next edit is based on the push version and keeps its nodes', async () => {
    const { srv, hooks, q } = setup()
    q.absorb(srv.push())
    // Built after the live merge: the canvas holds the browser node, the board version is still 10.
    await q.enqueue(board(10, 'edited', [AGENT, BROWSER]))
    expect(srv.sent).toEqual([11])
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(srv.get().name).toBe('edited')
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1', 'b1'])
  })

  it('a payload locked before the push and queued behind a save gets the pushed nodes and cable', async () => {
    const { srv, hooks, q } = setup()
    void q.enqueue(board(10, 'first'))
    srv.hooks.after = () => q.absorb(srv.push()) // the push lands right after 'first' is stored
    await q.enqueue(board(10, 'locked before the push')) // waits behind 'first', lacks b1
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(srv.get().name).toBe('locked before the push')
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1', 'b1'])
    expect(srv.get().bridges).toEqual([CABLE])
  })

  it('a save in flight that the push beat is resent on the push version with the pushed nodes, no conflict', async () => {
    const { srv, hooks, q } = setup()
    srv.hooks.before = () => q.absorb(srv.push()) // stored + frame delivered before the request is handled
    await q.enqueue(board(10, 'mine'))
    expect(srv.sent).toEqual([10, 11])
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(q.getState()).toEqual({ kind: 'idle' })
    expect(srv.get().name).toBe('mine')
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1', 'b1'])
  })

  it('a push on top of our own save whose answer is still on the way chains once the answer lands', async () => {
    const { srv, hooks, q } = setup()
    srv.hooks.after = () => q.absorb(srv.push()) // base 11 is our save, not yet confirmed to the queue
    await q.enqueue(board(10, 'mine'))
    await q.enqueue(board(10, 'next', [AGENT, BROWSER]))
    expect(srv.sent).toEqual([10, 12])
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(srv.get().name).toBe('next')
  })

  it('a push on top of a write this window never saw is not a safe base: the next save is a conflict', async () => {
    const { srv, hooks, q } = setup()
    srv.set(board(11, 'other window'))
    q.absorb(srv.push()) // base 11 is unknown here
    await q.enqueue(board(10, 'mine', [AGENT, BROWSER]))
    expect(hooks.onStale).toHaveBeenCalledTimes(1)
    expect(srv.get().name).toBe('other window') // not overwritten
  })

  it('a node deleted after the merge stays deleted', async () => {
    const { srv, q } = setup()
    q.absorb(srv.push())
    await q.enqueue(board(10, 'closed the browser', [AGENT]))
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1'])
  })

  it('a payload locked before a remove is sent without the removed node and its cable, on the push version', async () => {
    const withBrowser = { ...board(10, 'w', [AGENT, BROWSER]), bridges: [CABLE] }
    const { srv, hooks, q } = setup(withBrowser)
    void q.enqueue({ ...withBrowser, name: 'first' })
    srv.hooks.after = () => q.absorb(srv.remove(['b1'])) // Central closes b1 right after 'first' is stored
    await q.enqueue({ ...withBrowser, name: 'locked before the remove' }) // still holds b1 + cable
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(srv.get().name).toBe('locked before the remove')
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1'])
    expect(srv.get().bridges).toEqual([])
  })

  it('a save in flight that a remove beat is resent without the removed node', async () => {
    const withBrowser = { ...board(10, 'w', [AGENT, BROWSER]), bridges: [CABLE] }
    const { srv, hooks, q } = setup(withBrowser)
    srv.hooks.before = () => q.absorb(srv.remove(['b1']))
    await q.enqueue({ ...withBrowser, name: 'mine' })
    expect(srv.sent).toEqual([10, 11])
    expect(hooks.onStale).not.toHaveBeenCalled()
    expect(srv.get().nodes.map((n) => n.id)).toEqual(['agent-1'])
    expect(srv.get().bridges).toEqual([])
  })

  it('merging ignores ids the board already has', () => {
    const ws = { ...board(10, 'w', [AGENT, BROWSER]), bridges: [CABLE] }
    expect(mergeCanvasPush(ws, { nodes: [{ ...BROWSER, url: 'changed' }], bridges: [CABLE] })).toBe(ws)
  })
})

describe('applyCanvasPush (mounted board)', () => {
  const live = (activeId: string, nodes: Node[] = [{ id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, data: {}, selected: true }], edges: Edge[] = []) => {
    const state = { nodes, edges }
    const b: LiveBoard = {
      recordClosed: vi.fn(),
      activeWsRef: { current: { ...board(10), id: activeId } },
      nodesRef: { current: state.nodes },
      edgesRef: { current: state.edges },
      setNodes: vi.fn((u) => { state.nodes = typeof u === 'function' ? u(state.nodes) : u }),
      setEdges: vi.fn((u) => { state.edges = typeof u === 'function' ? u(state.edges) : u }),
    }
    return { b, state }
  }
  const msg = (nodes: WsNode[]): CanvasMsg => ({ t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes, bridges: [CABLE] })

  it('merges new nodes and cables into the live canvas without selecting them or moving selection', () => {
    const { b, state } = live('w1')
    expect(applyCanvasPush(b, msg([AGENT, BROWSER]))).toBe(true)
    expect(state.nodes.map((n) => n.id)).toEqual(['agent-1', 'b1'])
    expect(state.nodes.map((n) => Boolean(n.selected))).toEqual([true, false])
    expect(b.nodesRef.current.map((n) => n.id)).toEqual(['agent-1', 'b1'])
    expect(state.edges.map((e) => e.id)).toEqual([CABLE.id])
    expect(b.edgesRef.current).toEqual(state.edges)
    // A repeated frame adds nothing.
    applyCanvasPush(b, msg([BROWSER]))
    expect(state.nodes).toHaveLength(2)
    expect(state.edges).toHaveLength(1)
  })

  it('leaves another board untouched', () => {
    const { b, state } = live('w2')
    const before = b.nodesRef.current
    expect(applyCanvasPush(b, msg([BROWSER]))).toBe(false)
    expect(b.nodesRef.current).toBe(before)
    expect(state.nodes).toHaveLength(1)
    expect(b.setNodes).not.toHaveBeenCalled()
    expect(b.setEdges).not.toHaveBeenCalled()
  })

  it('drops removed nodes and every cable touching them, records them for Reopen, and sends no close', () => {
    const flow = (id: string, type: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: {} })
    const keep = { id: 'bridge-agent-1-t2', source: 'agent-1', target: 't2' }
    const { b, state } = live('w1', [flow('agent-1', 'agent'), flow('b1', 'browser'), flow('t1', 'terminal'), flow('t2', 'terminal')], [
      { id: CABLE.id, source: 'agent-1', target: 'b1' }, { id: 'bridge-t1-agent-1', source: 't1', target: 'agent-1' }, keep,
    ])
    const removal: CanvasMsg = { t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes: [], bridges: [], removed: ['b1', 't1', 'unknown'] }
    expect(applyCanvasPush(b, removal)).toBe(true)
    expect(state.nodes.map((n) => n.id)).toEqual(['agent-1', 't2'])
    expect(b.nodesRef.current.map((n) => n.id)).toEqual(['agent-1', 't2'])
    expect(state.edges.map((e) => e.id)).toEqual([keep.id])
    expect(b.edgesRef.current.map((e) => e.id)).toEqual([keep.id])
    expect(b.recordClosed).toHaveBeenCalledTimes(1)
    const [ids, snapshot, owner, cables] = vi.mocked(b.recordClosed).mock.calls[0]
    expect(ids).toEqual(['b1', 't1'])
    expect(snapshot.map((n) => n.id)).toEqual(['agent-1', 'b1', 't1', 't2']) // taken before the removal
    expect(owner?.id).toBe('w1')
    expect(cables?.map((c) => c.id)).toEqual([CABLE.id, 'bridge-t1-agent-1', keep.id])
    // The same frame again (another subscriber, a replay) records nothing twice.
    applyCanvasPush(b, removal)
    expect(b.recordClosed).toHaveBeenCalledTimes(1)
  })

  it('a removal for another board leaves the mounted board and its history alone', () => {
    const { b, state } = live('w2')
    expect(applyCanvasPush(b, { t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes: [], bridges: [], removed: ['agent-1'] })).toBe(false)
    expect(state.nodes).toHaveLength(1)
    expect(b.setNodes).not.toHaveBeenCalled()
    expect(b.recordClosed).not.toHaveBeenCalled()
  })

  it('the workspaces list entry of a board that is not mounted loses the removed nodes and cables', () => {
    const listed = { ...board(10, 'w', [AGENT, BROWSER]), bridges: [CABLE] }
    const after = mergeCanvasPush(listed, { nodes: [], bridges: [], removed: ['b1'] })
    expect(after.nodes.map((n) => n.id)).toEqual(['agent-1'])
    expect(after.bridges).toEqual([])
    expect(after.updatedAt).toBe(10) // the list keeps the version this window knew
    expect(mergeCanvasPush(after, { nodes: [], bridges: [], removed: ['b1'] })).toBe(after)
  })
})

describe('canvas update push (patched nodes, unlinked cables)', () => {
  const live = (nodes: Node[], edges: Edge[]) => {
    const state = { nodes, edges }
    const b: LiveBoard = {
      recordClosed: vi.fn(),
      activeWsRef: { current: board(10) },
      nodesRef: { current: state.nodes },
      edgesRef: { current: state.edges },
      setNodes: vi.fn((u) => { state.nodes = typeof u === 'function' ? u(state.nodes) : u }),
      setEdges: vi.fn((u) => { state.edges = typeof u === 'function' ? u(state.edges) : u }),
    }
    return { b, state }
  }
  const MOVED: WsNode = { ...AGENT, x: 300, y: 200, width: 700, title: 'Planner', collapsed: true } // no color, height: cleared
  const update: CanvasMsg = { t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes: [], bridges: [], updated: [MOVED], unlinked: [CABLE.id] }

  it('patches position, size and look in place, keeping selection, drag, measured state and other data', () => {
    const agent: Node = { id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, width: 400, height: 300, selected: true, dragging: true, measured: { width: 400, height: 300 }, data: { kind: 'agent', cmd: 'claude', color: '#f00', title: 'Old' } }
    const other: Node = { id: 'b1', type: 'browser', position: { x: 432, y: 0 }, data: {} }
    const keep = { id: 'keep', source: 'agent-1', target: 'b1' }
    const { b, state } = live([agent, other], [{ id: CABLE.id, source: 'agent-1', target: 'b1' }, keep])
    expect(applyCanvasPush(b, update)).toBe(true)
    const [a, o] = state.nodes
    expect(a).toMatchObject({ position: { x: 300, y: 200 }, width: 700, height: 300, selected: true, dragging: true, measured: { width: 400, height: 300 } })
    expect(a.data).toEqual({ kind: 'agent', cmd: 'claude', color: undefined, title: 'Planner', collapsed: true, hideLinks: undefined })
    expect(o).toBe(other)
    expect(b.nodesRef.current).toEqual(state.nodes)
    expect(state.edges).toEqual([keep])
    expect(b.edgesRef.current).toEqual([keep])
    expect(b.recordClosed).not.toHaveBeenCalled()
  })

  it('an update for nodes and cables the canvas lacks touches nothing', () => {
    const { b } = live([{ id: 'x', position: { x: 0, y: 0 }, data: {} }], [])
    applyCanvasPush(b, update)
    expect(b.setNodes).not.toHaveBeenCalled()
    expect(b.setEdges).not.toHaveBeenCalled()
  })

  it('a pending save locked before the push keeps the patched fields and loses the unlinked cable', async () => {
    const start = { ...board(10, 'w', [{ ...AGENT, color: '#f00' }, BROWSER]), bridges: [CABLE] }
    const srv = fakeServer(start)
    const hooks = { onStale: vi.fn(), onMissing: vi.fn() }
    const q = createSaveQueue(hooks, { save: srv.save })
    void q.enqueue({ ...start, name: 'first' })
    srv.hooks.after = () => {
      const base = srv.get().updatedAt
      srv.set(mergeCanvasPush({ ...srv.get(), updatedAt: base + 1 }, update))
      q.absorb({ ...update, base, updatedAt: base + 1 })
    }
    await q.enqueue({ ...start, name: 'locked before the update' }) // still holds the old x/y/title + cable
    expect(hooks.onStale).not.toHaveBeenCalled()
    const stored = srv.get()
    expect(stored.name).toBe('locked before the update')
    expect(stored.nodes[0]).toEqual(MOVED)
    expect(stored.nodes[1]).toEqual(BROWSER)
    expect(stored.bridges).toEqual([])
  })

  it('merging an update for nodes or cables the board lacks returns the same object', () => {
    const ws = { ...board(10, 'w', [AGENT]), bridges: [] }
    expect(mergeCanvasPush(ws, { nodes: [], bridges: [], unlinked: ['gone'] })).toBe(ws)
    expect(mergeCanvasPush(ws, { nodes: [], bridges: [], updated: [{ ...BROWSER }] })).toBe(ws)
    expect(mergeCanvasPush(ws, { nodes: [], bridges: [], updated: [MOVED] }).nodes).toEqual([MOVED])
  })
})

describe('canvas groups push (Central canvas.group)', () => {
  const GROUP = { id: 'g1', name: 'Docs', collapsed: false, ids: ['b1', 'agent-1'] }
  const grouped: CanvasMsg = { t: 'canvas', workspaceId: 'w1', base: 10, updatedAt: 11, nodes: [], bridges: [], groups: [GROUP] }
  const live = (activeId: string): LiveBoard => ({
    recordClosed: vi.fn(),
    activeWsRef: { current: { ...board(10, 'w', [AGENT, BROWSER]), id: activeId } },
    nodesRef: { current: [] }, edgesRef: { current: [] }, setNodes: vi.fn(), setEdges: vi.fn(),
  })
  beforeEach(() => {
    const base = defaultTabLayout()
    connectTabLayout({ ...base, tabs: { ...base.tabs, order: ['agent-1', 'b1'], active: 'agent-1' } }, null)
  })

  it('shows the groups in the store and puts them in the active payload, so the next save carries them', () => {
    const b = live('w1')
    expect(applyCanvasPush(b, grouped)).toBe(true)
    expect(getTabLayout().tabs.groups).toEqual([{ ...GROUP, ids: ['agent-1', 'b1'] }])
    expect(b.activeWsRef.current?.layout).toBe(getTabLayout())
  })

  it('a groups push for another board leaves the store and the payload alone', () => {
    const b = live('w2')
    const before = getTabLayout()
    expect(applyCanvasPush(b, grouped)).toBe(false)
    expect(getTabLayout()).toBe(before)
    expect(b.activeWsRef.current?.layout).toBeUndefined()
  })
})
