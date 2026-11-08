// A server canvas push (`t:'canvas'`) while this window holds unsent saves: the next save carries
// the pushed nodes and is based on the push's version (no 409, no dropped edit), and the mounted
// board merges them live.
import { describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasMsg } from '../shared/protocol'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'
import { createSaveQueue, mergeCanvasAdd } from './workspaceSaveQueue'
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
    stored = mergeCanvasAdd({ ...stored, updatedAt: base + 1 }, { nodes: [BROWSER], bridges: [CABLE] })
    return { t: 'canvas', workspaceId: stored.id, base, updatedAt: stored.updatedAt, nodes: [BROWSER], bridges: [CABLE] }
  }
  return { save, sent, hooks, push, get: () => stored, set: (ws: Workspace) => { stored = ws } }
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

  it('merging ignores ids the board already has', () => {
    const ws = { ...board(10, 'w', [AGENT, BROWSER]), bridges: [CABLE] }
    expect(mergeCanvasAdd(ws, { nodes: [{ ...BROWSER, url: 'changed' }], bridges: [CABLE] })).toBe(ws)
  })
})

describe('applyCanvasPush (mounted board)', () => {
  const live = (activeId: string) => {
    const state = { nodes: [{ id: 'agent-1', type: 'agent', position: { x: 0, y: 0 }, data: {}, selected: true }] as Node[], edges: [] as Edge[] }
    const b: LiveBoard = {
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
})
