// A node's preset (skill-author) drives the server-side tool lock, but the save body is client-controlled:
// it is fixed at birth in `Db.nodesColumn`. Real SQLite in memory.
import { expect, test } from 'bun:test'
import type { WsNode } from '../shared/workspace'
import { toFlow, toWsNode } from '../client/store'
import { agentChatOpenConfig } from './agentChat/agentChat.pool'
import { Db, openDb } from './db'

const LOCKED: WsNode = { id: 'c1', kind: 'agentChat', x: 0, y: 0, preset: 'skill-author', presetTarget: 'webterm-foo' }
const base = () => { const store = new Db(openDb(':memory:')); const ws = store.create('p'); return { store, ws } }
const stored = (s: Db, id: string, nid: string) => s.get(id)!.nodes.find((n) => n.id === nid)!

test('a new node is born with a known preset and valid target', () => {
  const { store, ws } = base()
  store.save({ ...ws, nodes: [LOCKED] })
  expect(stored(store, ws.id, 'c1')).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-foo' })
})

test('a save that drops or changes the preset of an existing node keeps the stored one', () => {
  const { store, ws } = base()
  store.save({ ...ws, nodes: [LOCKED] })
  const { preset: _p, presetTarget: _t, ...plain } = LOCKED
  store.save({ ...store.get(ws.id)!, nodes: [plain] })
  expect(stored(store, ws.id, 'c1')).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-foo' })
  store.save({ ...store.get(ws.id)!, nodes: [{ ...LOCKED, presetTarget: 'webterm-other' }] })
  expect(stored(store, ws.id, 'c1').presetTarget).toBe('webterm-foo')
})

test('a plain stored chat cannot gain a preset by a later save', () => {
  const { store, ws } = base()
  store.save({ ...ws, nodes: [{ id: 'c2', kind: 'agentChat', x: 0, y: 0 }] })
  store.save({ ...store.get(ws.id)!, nodes: [{ id: 'c2', kind: 'agentChat', x: 0, y: 0, preset: 'skill-author' }] })
  expect(stored(store, ws.id, 'c2').preset).toBe(undefined)
})

test('a new node with an unknown preset or a bad target drops the field', () => {
  const { store, ws } = base()
  store.save({ ...ws, nodes: [
    { id: 'a', kind: 'agentChat', x: 0, y: 0, preset: 'root' as never, presetTarget: 'webterm-foo' },
    { id: 'b', kind: 'agentChat', x: 0, y: 0, preset: 'skill-author', presetTarget: '../../etc' },
    { id: 'd', kind: 'agentChat', x: 0, y: 0, preset: 'skill-author', presetTarget: `webterm-${'a'.repeat(80)}` },
  ] })
  expect(stored(store, ws.id, 'a').preset).toBe(undefined)
  expect(stored(store, ws.id, 'a').presetTarget).toBe(undefined)
  expect(stored(store, ws.id, 'b')).toMatchObject({ preset: 'skill-author' })
  expect(stored(store, ws.id, 'b').presetTarget).toBe(undefined)
  expect(stored(store, ws.id, 'd').presetTarget).toBe(undefined)
})

test('after a simulated reload + save the node still yields the preset for the server lock', () => {
  const { store, ws } = base()
  store.save({ ...ws, nodes: [LOCKED] })
  const reloaded = store.get(ws.id)!.nodes.map((n) => toWsNode(toFlow(n)))
  store.save({ ...store.get(ws.id)!, nodes: reloaded })
  const node = stored(store, ws.id, 'c1')
  const cfg = agentChatOpenConfig({ node, ws: store.get(ws.id)! } as never, { port: 1, settings: {} as never })
  expect(cfg).toMatchObject({ preset: 'skill-author', presetTarget: 'webterm-foo' })
})
