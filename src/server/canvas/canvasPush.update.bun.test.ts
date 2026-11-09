// canvasPush.update over a real in-memory SQLite: patches, null clears, cables, refusals, the save race, the broadcast.
import { expect, test } from 'bun:test'
import type { ServerMsg } from '../../shared/protocol'
import type { Workspace, WsNode } from '../../shared/workspace'
import { Db, openDb } from '../db'
import { createCanvasPush } from './canvasPush'

const CABLE = { id: 'l-a-b', source: 'a', target: 'b', kind: 'context' as const }

function setup() {
  const db = new Db(openDb(':memory:'))
  const sent: ServerMsg[] = []
  const push = createCanvasPush({ db, broadcast: (m) => sent.push(m) })
  const ws = db.create('p', '/repo')
  const nodes: WsNode[] = [
    { id: 'a', kind: 'agent', x: 0, y: 0, width: 600, height: 400, title: 'Agent', color: '#f00', cmd: 'claude' },
    { id: 'b', kind: 'browser', x: 700, y: 0, url: 'https://example.com' },
    { id: 'c', kind: 'terminal', x: 0, y: 500 },
  ]
  db.save({ ...ws, nodes, bridges: [CABLE] }, ws.updatedAt)
  return { db, sent, push, ws: db.get(ws.id)! }
}

test('patches the allowed fields only, clears null title/color, stores them and broadcasts the full patched nodes', () => {
  const { db, sent, push, ws } = setup()
  const patch = { id: 'a', x: 50, y: 60, width: 800, title: null, color: null, collapsed: true, hideLinks: true, cmd: 'rm -rf /', kind: 'files' }
  const res = push.update({ workspaceId: ws.id, patches: [patch as never, { id: 'b', title: 'Docs' }] })
  if (!res.ok) throw new Error(`update refused: ${res.code}`)
  const stored = db.get(ws.id)!
  const a = stored.nodes.find((n) => n.id === 'a')!
  expect({ x: a.x, y: a.y, width: a.width, height: a.height, collapsed: a.collapsed, hideLinks: a.hideLinks }).toEqual({ x: 50, y: 60, width: 800, height: 400, collapsed: true, hideLinks: true })
  expect('title' in a || 'color' in a).toBe(false)
  expect({ cmd: a.cmd, kind: a.kind }).toEqual({ cmd: 'claude', kind: 'agent' }) // unknown keys ignored
  expect(stored.nodes.find((n) => n.id === 'b')!.title).toBe('Docs')
  expect(stored.nodes.find((n) => n.id === 'c')).toEqual(ws.nodes[2])
  expect(res.nodes).toEqual(stored.nodes.slice(0, 2))
  expect(res.updatedAt).toBe(stored.updatedAt)
  expect(sent).toEqual([{ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt: stored.updatedAt, nodes: [], bridges: [], updated: res.nodes, unlinked: [] }])
})

test('adds and removes cables; an existing cable id is skipped', () => {
  const { db, sent, push, ws } = setup()
  const add = { id: 'l-b-c', source: 'b', target: 'c', kind: 'context' as const }
  const res = push.update({ workspaceId: ws.id, patches: [], bridgesAdd: [add, CABLE, add], bridgesRemove: [CABLE.id, CABLE.id] })
  if (!res.ok) throw new Error(`update refused: ${res.code}`)
  expect(res).toMatchObject({ nodes: [], bridges: [add], unlinked: [CABLE.id] })
  expect(db.get(ws.id)!.bridges).toEqual([add])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ nodes: [], bridges: [add], updated: [], unlinked: [CABLE.id] })
})

test('refuses the whole request on an unknown node, cable end or cable id, and an unknown board, writing nothing', () => {
  const { db, sent, push, ws } = setup()
  const other = db.create('q')
  db.save({ ...other, nodes: [{ id: 'elsewhere', kind: 'terminal', x: 0, y: 0 }] }, other.updatedAt)
  expect(push.update({ workspaceId: ws.id, patches: [{ id: 'a', x: 1 }, { id: 'missing', x: 1 }] })).toEqual({ ok: false, code: 'node_not_found' })
  expect(push.update({ workspaceId: ws.id, patches: [{ id: 'elsewhere', x: 1 }] })).toEqual({ ok: false, code: 'node_not_found' })
  expect(push.update({ workspaceId: ws.id, patches: [{ id: 'a', x: 1 }], bridgesAdd: [{ id: 'x', source: 'a', target: 'elsewhere', kind: 'context' }] })).toEqual({ ok: false, code: 'bridge_invalid' })
  expect(push.update({ workspaceId: ws.id, patches: [], bridgesAdd: [{ id: 'x', source: 'a', target: 'a', kind: 'context' }] })).toEqual({ ok: false, code: 'bridge_invalid' })
  expect(push.update({ workspaceId: ws.id, patches: [{ id: 'a', x: 1 }], bridgesRemove: ['nope'] })).toEqual({ ok: false, code: 'bridge_not_found' })
  expect(push.update({ workspaceId: 'nope', patches: [] })).toEqual({ ok: false, code: 'workspace_not_found' })
  expect(db.get(ws.id)).toEqual(ws)
  expect(sent).toHaveLength(0)
})

test('an empty request is a no-op: no save, no broadcast', () => {
  const { db, sent, push, ws } = setup()
  expect(push.update({ workspaceId: ws.id, patches: [], bridgesAdd: [CABLE] })).toEqual({ ok: true, updatedAt: ws.updatedAt, nodes: [], bridges: [], unlinked: [] })
  expect(db.get(ws.id)).toEqual(ws)
  expect(sent).toHaveLength(0)
})

test('a UI save that wins the race is kept: update re-reads and patches on top of it; losing every race throws', () => {
  const { db, sent, ws } = setup()
  let raced = false
  const base = { get: (id: string) => db.get(id), list: () => db.list(), getActive: () => db.getActive(), nodeIds: () => db.nodeIds() }
  const racing = {
    ...base,
    save: (next: Workspace, b?: number) => {
      if (!raced) {
        raced = true
        const cur = db.get(next.id)!
        db.save({ ...cur, name: 'renamed by the UI', nodes: cur.nodes.map((n) => (n.id === 'c' ? { ...n, x: 999 } : n)) }, cur.updatedAt)
      }
      return db.save(next, b)
    },
  }
  const res = createCanvasPush({ db: racing, broadcast: (m) => sent.push(m) }).update({ workspaceId: ws.id, patches: [{ id: 'a', x: 5 }] })
  expect(res.ok).toBe(true)
  const stored = db.get(ws.id)!
  expect(stored.name).toBe('renamed by the UI')
  expect(stored.nodes.map((n) => n.x)).toEqual([5, 700, 999])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ updatedAt: stored.updatedAt })
  let thrown: unknown
  try { createCanvasPush({ db: { ...base, save: () => 'stale' as const }, broadcast: () => {} }).update({ workspaceId: ws.id, patches: [{ id: 'a', x: 1 }] }) } catch (err) { thrown = err }
  expect(thrown instanceof Error && thrown.message).toMatch(/lost 5 save races/)
})
