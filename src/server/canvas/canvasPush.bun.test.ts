// canvasPush over a real in-memory SQLite: placement, cables, refusals, the save race and the broadcast.
import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import type { CanvasMsg, ServerMsg } from '../../shared/protocol'
import type { Workspace, WsNode } from '../../shared/workspace'
import { Db, openDb } from '../db'
import { createCanvasPush } from './canvasPush'

const overlaps = (a: WsNode, b: WsNode): boolean =>
  a.x < b.x + (b.width ?? 400) && a.x + (a.width ?? 400) > b.x && a.y < b.y + (b.height ?? 300) && a.y + (a.height ?? 300) > b.y

function setup() {
  const db = new Db(openDb(':memory:'))
  const sent: ServerMsg[] = []
  const push = createCanvasPush({ db, broadcast: (m) => sent.push(m) })
  const ws = db.create('p', '/repo')
  const anchor: WsNode = { id: 'agent-1', kind: 'agent', x: 100, y: 100, width: 600, height: 400 }
  const blocker: WsNode = { id: 'files-1', kind: 'files', x: 100 + 600 + 32, y: 100, width: 400, height: 400 } // right of the anchor
  db.save({ ...ws, nodes: [anchor, blocker] }, ws.updatedAt)
  return { db, sent, push, ws: db.get(ws.id)! }
}

test('places new nodes beside the anchor in free space, stores them and the cable, and broadcasts the stored version', () => {
  const { db, sent, push, ws } = setup()
  const res = push.add({
    workspaceId: ws.id,
    anchorNodeId: 'agent-1',
    nodes: [{ id: 'b1', kind: 'browser', url: 'https://example.com', x: 0, y: 0, width: 640, height: 400 }, { id: 'b2', kind: 'browser', x: 0, y: 0 }],
    bridges: [{ id: 'bridge-agent-1-b1', source: 'agent-1', target: 'b1', kind: 'context' }],
  })
  if (!res.ok) throw new Error(`add refused: ${res.code}`)
  const stored = db.get(ws.id)!
  expect(stored.nodes.map((n) => n.id)).toEqual(['agent-1', 'files-1', 'b1', 'b2'])
  expect(stored.bridges).toEqual([{ id: 'bridge-agent-1-b1', source: 'agent-1', target: 'b1', kind: 'context' }])
  // Right of the anchor is taken, so the first goes below it.
  expect({ x: res.nodes[0].x, y: res.nodes[0].y }).toEqual({ x: 100, y: 100 + 400 + 32 })
  const all = stored.nodes
  for (const a of all) for (const b of all) if (a !== b) expect(overlaps(a, b)).toBe(false)
  expect(res.updatedAt).toBe(stored.updatedAt)
  expect(sent).toHaveLength(1)
  const msg = sent[0] as CanvasMsg
  expect(msg).toEqual({ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt: stored.updatedAt, nodes: res.nodes, bridges: stored.bridges })
})

test('an existing cable id is not written twice', () => {
  const { db, push, ws } = setup()
  const bridge = { id: 'bridge-x', source: 'agent-1', target: 'files-1', kind: 'context' as const }
  db.save({ ...ws, bridges: [bridge] }, ws.updatedAt)
  const res = push.add({ workspaceId: ws.id, nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0 }], bridges: [bridge] })
  expect(res.ok).toBe(true)
  expect(db.get(ws.id)!.bridges).toEqual([bridge])
})

test('refuses an unknown board and a node id that already exists anywhere, writing nothing', () => {
  const { db, sent, push, ws } = setup()
  expect(push.add({ workspaceId: 'nope', nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0 }] })).toEqual({ ok: false, code: 'workspace_not_found' })
  const other = db.create('q')
  expect(push.add({ workspaceId: other.id, nodes: [{ id: 'agent-1', kind: 'terminal', x: 0, y: 0 }] })).toEqual({ ok: false, code: 'node_exists' })
  expect(push.add({ workspaceId: ws.id, nodes: [{ id: 'd', kind: 'terminal', x: 0, y: 0 }, { id: 'd', kind: 'terminal', x: 0, y: 0 }] })).toEqual({ ok: false, code: 'node_exists' })
  expect(db.get(other.id)!.nodes).toEqual([])
  expect(db.get(ws.id)!.nodes).toHaveLength(2)
  expect(sent).toHaveLength(0)
})

test('a UI save that wins between read and write is kept: the add re-reads and lands on top of it', () => {
  const { db, sent, ws } = setup()
  let raced = false
  const racing = {
    get: (id: string) => db.get(id),
    list: () => db.list(),
    getActive: () => db.getActive(),
    nodeIds: () => db.nodeIds(),
    save: (next: Workspace, base?: number) => {
      if (!raced) {
        raced = true
        const cur = db.get(next.id)!
        db.save({ ...cur, name: 'renamed by the UI', nodes: [...cur.nodes, { id: 'ui-1', kind: 'terminal', x: 5000, y: 5000 }] }, cur.updatedAt)
      }
      return db.save(next, base)
    },
  }
  const res = createCanvasPush({ db: racing, broadcast: (m) => sent.push(m) }).add({ workspaceId: ws.id, nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0 }] })
  expect(res.ok).toBe(true)
  const stored = db.get(ws.id)!
  expect(stored.name).toBe('renamed by the UI')
  expect(stored.nodes.map((n) => n.id)).toEqual(['agent-1', 'files-1', 'ui-1', 'n1'])
  expect(sent).toHaveLength(1)
  expect((sent[0] as CanvasMsg).updatedAt).toBe(stored.updatedAt)
})

test('workspaceOfNode finds the owning board; workspaceForCwd picks the nearest board root, else the active board', () => {
  const { db, push, ws } = setup()
  const nested = db.create('nested', '/repo/packages/app')
  const elsewhere = db.create('elsewhere', '~/proj')
  expect(push.workspaceOfNode('files-1')?.id).toBe(ws.id)
  expect(push.workspaceOfNode('missing')).toBeNull()
  expect(push.workspaceForCwd('/repo/packages/app/src')?.id).toBe(nested.id)
  expect(push.workspaceForCwd('/repo/packages')?.id).toBe(ws.id)
  expect(push.workspaceForCwd(`${homedir()}/proj/x`)?.id).toBe(elsewhere.id)
  db.setActive(nested.id)
  expect(push.workspaceForCwd('/repository')?.id).toBe(nested.id) // a string prefix, not a parent dir
  expect(push.workspaceForCwd('/tmp/unrelated')?.id).toBe(nested.id)
})

function removeSetup() {
  const db = new Db(openDb(':memory:'))
  const sent: ServerMsg[] = []
  const tornDown: WsNode[][] = []
  const push = createCanvasPush({ db, broadcast: (m) => sent.push(m), teardown: (n) => { tornDown.push(n) } })
  const ws = db.create('p', '/repo')
  const nodes: WsNode[] = [
    { id: 'agent-1', kind: 'agent', x: 0, y: 0 },
    { id: 'b1', kind: 'browser', x: 500, y: 0 },
    { id: 't1', kind: 'terminal', x: 0, y: 400, panes: { dir: 'h', ratio: 0.5, a: { id: 't1' }, b: { id: 't1-p2' } } },
  ]
  const bridges = [
    { id: 'l-agent-b1', source: 'agent-1', target: 'b1', kind: 'context' as const },
    { id: 'l-t1-agent', source: 't1', target: 'agent-1', kind: 'context' as const },
  ]
  db.save({ ...ws, nodes, bridges }, ws.updatedAt)
  return { db, sent, tornDown, push, ws: db.get(ws.id)! }
}

test('remove takes nodes and every cable touching them off the board, then tears them down and broadcasts the ids', () => {
  const { db, sent, tornDown, push, ws } = removeSetup()
  const res = push.remove({ workspaceId: ws.id, nodeIds: ['b1', 't1', 'b1'] })
  if (!res.ok) throw new Error(`remove refused: ${res.code}`)
  const stored = db.get(ws.id)!
  expect(stored.nodes.map((n) => n.id)).toEqual(['agent-1'])
  expect(stored.bridges).toEqual([])
  expect(res.workspace).toEqual(stored)
  expect(res.removed.map((n) => n.id)).toEqual(['b1', 't1'])
  expect(tornDown).toEqual([res.removed]) // once, with the panes the session close needs
  expect(tornDown[0][1].panes).toBeDefined()
  expect(sent).toEqual([{ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt: stored.updatedAt, nodes: [], bridges: [], removed: ['b1', 't1'] }])
})

test('remove refuses the whole request when any id is not on that board, and an unknown board', () => {
  const { db, sent, tornDown, push, ws } = removeSetup()
  const other = db.create('q')
  db.save({ ...other, nodes: [{ id: 'elsewhere', kind: 'terminal', x: 0, y: 0 }] }, other.updatedAt)
  expect(push.remove({ workspaceId: ws.id, nodeIds: ['b1', 'missing'] })).toEqual({ ok: false, code: 'node_not_found' })
  expect(push.remove({ workspaceId: ws.id, nodeIds: ['b1', 'elsewhere'] })).toEqual({ ok: false, code: 'node_not_found' })
  expect(push.remove({ workspaceId: 'nope', nodeIds: ['b1'] })).toEqual({ ok: false, code: 'workspace_not_found' })
  expect(db.get(ws.id)).toEqual(ws)
  expect(sent).toHaveLength(0)
  expect(tornDown).toHaveLength(0)
})

test('a UI save that wins the race is kept: remove re-reads and removes from it; a failing teardown never undoes the removal', () => {
  const { db, sent, ws } = removeSetup()
  let raced = false
  const racing = {
    get: (id: string) => db.get(id),
    list: () => db.list(),
    getActive: () => db.getActive(),
    nodeIds: () => db.nodeIds(),
    save: (next: Workspace, base?: number) => {
      if (!raced) {
        raced = true
        const cur = db.get(next.id)!
        db.save({ ...cur, name: 'renamed by the UI' }, cur.updatedAt)
      }
      return db.save(next, base)
    },
  }
  const teardown = () => { throw new Error('pty gone') }
  const res = createCanvasPush({ db: racing, broadcast: (m) => sent.push(m), teardown }).remove({ workspaceId: ws.id, nodeIds: ['agent-1'] })
  expect(res.ok).toBe(true)
  const stored = db.get(ws.id)!
  expect(stored.name).toBe('renamed by the UI')
  expect(stored.nodes.map((n) => n.id)).toEqual(['b1', 't1'])
  expect(stored.bridges).toEqual([])
  expect((sent[0] as CanvasMsg).updatedAt).toBe(stored.updatedAt)
})

test('remove throws after losing every save race', () => {
  const { db, ws } = removeSetup()
  const alwaysStale = { get: (id: string) => db.get(id), list: () => db.list(), getActive: () => db.getActive(), nodeIds: () => db.nodeIds(), save: () => 'stale' as const }
  let thrown: unknown
  try { createCanvasPush({ db: alwaysStale, broadcast: () => {} }).remove({ workspaceId: ws.id, nodeIds: ['b1'] }) } catch (err) { thrown = err }
  expect(thrown instanceof Error && thrown.message).toMatch(/lost 5 save races/)
  expect(db.get(ws.id)!.nodes).toHaveLength(3)
})

test('added nodes are named before the save, so the live push carries the names the row stores, unique per board', () => {
  const { db, sent, push, ws } = setup()
  const taken = ws.nodes.map((n) => n.name!)
  const res = push.add({ workspaceId: ws.id, nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, name: taken[0] }, { id: 'n2', kind: 'terminal', x: 0, y: 0 }] })
  if (!res.ok) throw new Error(`add refused: ${res.code}`)
  const stored = db.get(ws.id)!
  expect(stored.nodes.slice(2)).toEqual(res.nodes)
  expect((sent[0] as CanvasMsg).nodes.map((n) => n.name)).toEqual(res.nodes.map((n) => n.name))
  const names = stored.nodes.map((n) => n.name!.toLowerCase())
  expect(new Set(names).size).toBe(4)
  expect(stored.nodes.slice(0, 2).map((n) => n.name)).toEqual(taken) // existing names never move
  const gone = push.remove({ workspaceId: ws.id, nodeIds: ['n2'] })
  if (!gone.ok) throw new Error(`remove refused: ${gone.code}`)
  expect(gone.removed[0].name).toBe(res.nodes[1].name)
})
