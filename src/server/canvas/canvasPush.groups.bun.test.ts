// canvasPush.groups over a real in-memory SQLite: each op stored + broadcast, reconcile, refusals, no-op, the save race.
import { expect, test } from 'bun:test'
import type { ServerMsg } from '../../shared/protocol'
import { defaultTabLayout } from '../../shared/tabLayout.schema'
import type { Workspace, WsNode } from '../../shared/workspace'
import { Db, openDb } from '../db'
import { createCanvasPush } from './canvasPush'

function setup() {
  const db = new Db(openDb(':memory:'))
  const sent: ServerMsg[] = []
  const push = createCanvasPush({ db, broadcast: (m) => sent.push(m) })
  const ws = db.create('p', '/repo')
  const nodes: WsNode[] = ['a', 'b', 'c'].map((id) => ({ id, kind: 'terminal', x: 0, y: 0 }))
  const layout = defaultTabLayout()
  db.save({ ...ws, nodes, layout: { ...layout, tabs: { ...layout.tabs, order: ['a', 'b', 'c'] } } }, ws.updatedAt)
  return { db, sent, push, ws: db.get(ws.id)! }
}
const tabsOf = (db: Db, id: string) => db.get(id)!.layout!.tabs

test('create stores the group, keeps the rest of the layout and broadcasts the group list', () => {
  const { db, sent, push, ws } = setup()
  const res = push.groups({ workspaceId: ws.id, op: { op: 'create', name: 'Docs', nodeIds: ['c', 'a'] } })
  if (!res.ok) throw new Error(`groups refused: ${res.code}`)
  expect(res.groupId).toMatch(/^g-[0-9a-f-]{36}$/)
  const stored = db.get(ws.id)!
  expect(stored.layout!.tabs.groups).toEqual([{ id: res.groupId!, name: 'Docs', collapsed: false, ids: ['a', 'c'] }]) // board order, as packGroups keeps it
  expect(stored.layout!.tabs.order).toEqual(['a', 'c', 'b']) // members packed at the first member's slot
  expect(stored.layout!.mode).toBe(ws.layout!.mode)
  expect(stored.nodes).toEqual(ws.nodes)
  expect(res).toEqual({ ok: true, updatedAt: stored.updatedAt, groups: stored.layout!.tabs.groups, groupId: res.groupId })
  expect(sent).toEqual([{ t: 'canvas', workspaceId: ws.id, base: ws.updatedAt, updatedAt: stored.updatedAt, nodes: [], bridges: [], groups: res.groups }])
})

test('add, remove, rename, collapse and ungroup follow the human rules', () => {
  const { db, push, ws } = setup()
  const made = push.groups({ workspaceId: ws.id, op: { op: 'create', nodeIds: ['a'] } })
  if (!made.ok) throw new Error(made.code)
  expect(made.groups[0].name).toBe('Group 1')
  const g = made.groupId!
  push.groups({ workspaceId: ws.id, op: { op: 'add', group: 'group 1', nodeIds: ['c'] } })
  expect(tabsOf(db, ws.id)).toMatchObject({ order: ['a', 'c', 'b'], groups: [{ ids: ['a', 'c'] }] })
  push.groups({ workspaceId: ws.id, op: { op: 'remove', group: g, nodeIds: ['a'] } })
  expect(tabsOf(db, ws.id)).toMatchObject({ order: ['c', 'a', 'b'], groups: [{ ids: ['c'] }] }) // out, in place
  push.groups({ workspaceId: ws.id, op: { op: 'rename', group: g, name: '  Web  ' } })
  push.groups({ workspaceId: ws.id, op: { op: 'collapse', group: 'web', collapsed: true } })
  expect(tabsOf(db, ws.id).groups).toEqual([{ id: g, name: 'Web', collapsed: true, ids: ['c'] }])
  const res = push.groups({ workspaceId: ws.id, op: { op: 'ungroup', group: 'WEB' } })
  expect(res).toMatchObject({ ok: true, groups: [] })
  expect(tabsOf(db, ws.id)).toMatchObject({ order: ['c', 'a', 'b'], groups: [] })
})

test('a node missing from the stored order (opened by Central, no window reconciled yet) can be grouped', () => {
  const { db, push, ws } = setup()
  db.save({ ...ws, nodes: [...ws.nodes, { id: 'd', kind: 'browser', x: 0, y: 0 }] }, ws.updatedAt)
  const res = push.groups({ workspaceId: ws.id, op: { op: 'create', nodeIds: ['d'] } })
  expect(res).toMatchObject({ ok: true, groups: [{ ids: ['d'] }] })
  expect(tabsOf(db, ws.id).order).toEqual(['a', 'b', 'c', 'd'])
})

test('refusals write nothing and broadcast nothing', () => {
  const { db, sent, push, ws } = setup()
  const made = push.groups({ workspaceId: ws.id, op: { op: 'create', name: 'Docs', nodeIds: ['a'] } })
  if (!made.ok) throw new Error(made.code)
  push.groups({ workspaceId: ws.id, op: { op: 'create', name: 'docs', nodeIds: ['b'] } })
  const before = db.get(ws.id)
  sent.length = 0
  const id = ws.id
  expect(push.groups({ workspaceId: id, op: { op: 'add', group: made.groupId!, nodeIds: ['b', 'ghost'] } })).toEqual({ ok: false, code: 'node_not_found' })
  expect(push.groups({ workspaceId: id, op: { op: 'rename', group: 'nope', name: 'x' } })).toEqual({ ok: false, code: 'group_not_found' })
  expect(push.groups({ workspaceId: id, op: { op: 'ungroup', group: 'DOCS' } })).toEqual({ ok: false, code: 'group_ambiguous' })
  expect(push.groups({ workspaceId: id, op: { op: 'remove', group: made.groupId!, nodeIds: ['a', 'c'] } })).toEqual({ ok: false, code: 'node_not_in_group' })
  expect(push.groups({ workspaceId: 'nope', op: { op: 'ungroup', group: 'x' } })).toEqual({ ok: false, code: 'workspace_not_found' })
  expect(db.get(ws.id)).toEqual(before)
  expect(sent).toHaveLength(0)
})

test('an edit that changes nothing is a no-op: no save, no broadcast', () => {
  const { db, sent, push, ws } = setup()
  const made = push.groups({ workspaceId: ws.id, op: { op: 'create', name: 'Docs', nodeIds: ['a'] } })
  if (!made.ok) throw new Error(made.code)
  const before = db.get(ws.id)!
  sent.length = 0
  expect(push.groups({ workspaceId: ws.id, op: { op: 'collapse', group: 'Docs', collapsed: false } }))
    .toEqual({ ok: true, updatedAt: before.updatedAt, groups: made.groups, groupId: made.groupId })
  expect(db.get(ws.id)).toEqual(before)
  expect(sent).toHaveLength(0)
})

test('a UI save that wins the race is kept: groups re-reads and applies on top of it; losing every race throws', () => {
  const { db, sent, ws } = setup()
  let raced = false
  const base = { get: (id: string) => db.get(id), list: () => db.list(), getActive: () => db.getActive(), nodeIds: () => db.nodeIds() }
  const racing = {
    ...base,
    save: (next: Workspace, b?: number) => {
      if (!raced) {
        raced = true
        const cur = db.get(next.id)!
        db.save({ ...cur, name: 'renamed by the UI', layout: { ...cur.layout!, mode: 'tabs' } }, cur.updatedAt)
      }
      return db.save(next, b)
    },
  }
  const res = createCanvasPush({ db: racing, broadcast: (m) => sent.push(m) }).groups({ workspaceId: ws.id, op: { op: 'create', nodeIds: ['b'] } })
  expect(res.ok).toBe(true)
  const stored = db.get(ws.id)!
  expect(stored.name).toBe('renamed by the UI')
  expect(stored.layout!.mode).toBe('tabs')
  expect(stored.layout!.tabs.groups).toMatchObject([{ ids: ['b'] }])
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ updatedAt: stored.updatedAt })
  let thrown: unknown
  try { createCanvasPush({ db: { ...base, save: () => 'stale' as const }, broadcast: () => {} }).groups({ workspaceId: ws.id, op: { op: 'create', nodeIds: ['a'] } }) } catch (err) { thrown = err }
  expect(thrown instanceof Error && thrown.message).toMatch(/lost 5 save races/)
})
