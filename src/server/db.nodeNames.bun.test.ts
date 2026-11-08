// Db is the single naming point: every node it stores or serves has a unique handle (shared/nodeNames).
import { expect, test } from 'bun:test'
import type { WsNode } from '../shared/workspace'
import { NODE_NAMES } from '../shared/nodeNames'
import { Db, openDb } from './db'

const node = (id: string, extra: Partial<WsNode> = {}): WsNode => ({ id, kind: 'terminal', x: 0, y: 0, ...extra })
const rawNodes = (d: ReturnType<typeof openDb>, id: string): WsNode[] =>
  JSON.parse((d.query('SELECT nodes FROM workspace WHERE id = ?').get(id) as { nodes: string }).nodes)

test('save stores unique names, keeps given ones and renames a later duplicate; get serves them', () => {
  const d = openDb(':memory:')
  const store = new Db(d)
  const ws = store.create('p')
  expect(store.save({ ...ws, nodes: [node('a', { name: 'Mango' }), node('b', { name: 'mango' }), node('c')] }, ws.updatedAt)).toBe('saved')
  const raw = rawNodes(d, ws.id)
  expect(raw[0].name).toBe('Mango')
  expect(raw[1].name).not.toMatch(/^mango$/i)
  expect(NODE_NAMES).toContain(raw[2].name)
  expect(new Set(raw.map((n) => n.name!.toLowerCase())).size).toBe(3)
  expect(store.get(ws.id)!.nodes.map((n) => n.name)).toEqual(raw.map((n) => n.name))
})

test('a legacy row without names reads named, and the names stay put once a save stores them', () => {
  const d = openDb(':memory:')
  const store = new Db(d)
  const ws = store.create('p')
  d.query('UPDATE workspace SET nodes = ? WHERE id = ?').run(JSON.stringify([node('x'), node('y')]), ws.id)
  const read = store.get(ws.id)!
  const names = read.nodes.map((n) => n.name)
  expect(names.every((n) => typeof n === 'string' && n !== '')).toBe(true)
  expect(store.list()[0].nodes.map((n) => n.name)).toEqual(names)
  expect(store.listSummaries(10).items[0].nodes.map((n) => n.name)).toEqual(names)
  store.save({ ...read, nodes: [...read.nodes, node('z')] }, read.updatedAt)
  expect(rawNodes(d, ws.id).slice(0, 2).map((n) => n.name)).toEqual(names)
})
