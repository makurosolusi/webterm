// Bun-only (needs bun:sqlite); runs under `bun test`, excluded from vitest via
// the **/*.bun.test.ts suffix. Uses only toBe/toContain, the matchers the
// ambient bun:test declaration (src/server/bun-test.d.ts) exposes.
import { test, expect } from 'bun:test'
import type { WsNode } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { Db, openDb } from './db'

function freshDb(): Db {
  return new Db(openDb(':memory:'))
}

test('create mints a workspace with defaults; get deep-equals it', () => {
  const db = freshDb()
  const ws = db.create('proj', '/tmp', '#fff')
  expect(ws.id.length > 0).toBe(true)
  expect(ws.nodes.length).toBe(0)
  expect(JSON.stringify(ws.viewport)).toBe(JSON.stringify(DEFAULT_VIEWPORT))
  expect(JSON.stringify(db.get(ws.id))).toBe(JSON.stringify(ws))
})

test('save round-trips nodes with cmd/agentId intact', () => {
  const db = freshDb()
  const ws = db.create('proj')
  const nodes: WsNode[] = [
    { id: 'n1', kind: 'terminal', x: 1, y: 2 },
    { id: 'n2', kind: 'agent', x: 3, y: 4, cmd: 'envman -e work -- claude', agentId: 'claude' },
  ]
  ws.nodes = nodes
  db.save(ws)
  const got = db.get(ws.id)
  expect(JSON.stringify(got?.nodes)).toBe(JSON.stringify(nodes))
})

test('setActive / getActive', () => {
  const db = freshDb()
  const ws = db.create('proj')
  db.setActive(ws.id)
  expect(db.getActive()).toBe(ws.id)
})

test('delete removes from get and list', () => {
  const db = freshDb()
  const ws = db.create('proj')
  db.delete(ws.id)
  expect(db.get(ws.id)).toBe(null)
  expect(db.list().some((w) => w.id === ws.id)).toBe(false)
})
