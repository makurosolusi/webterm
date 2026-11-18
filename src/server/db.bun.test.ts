// Bun-only (needs bun:sqlite); runs under `bun test`, excluded from vitest via
// the **/*.bun.test.ts suffix. Uses only toBe/toContain, the matchers the
// ambient bun:test declaration (src/server/bun-test.d.ts) exposes.
import { test, expect } from 'bun:test'
import type { WsNode } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { Db, openDb } from './db'

function freshDb(): Db {
  return new Db(openDb(':memory:'))
}

test('create mints a workspace with defaults; get deep-equals it', () => {
  const db = freshDb()
  const ws = db.create('proj', '/tmp', 'blue')
  expect(ws.id.length > 0).toBe(true)
  expect(ws.nodes.length).toBe(0)
  expect(JSON.stringify(ws.viewport)).toBe(JSON.stringify(DEFAULT_VIEWPORT))
  expect(JSON.stringify(db.get(ws.id))).toBe(JSON.stringify(ws))
})

test('save round-trips nodes with cmd/agentId intact', () => {
  const db = freshDb()
  const ws = db.create('proj')
  const nodes: WsNode[] = [
    { id: 'n1', kind: 'terminal', x: 1, y: 2, name: 'Mango' },
    { id: 'n2', kind: 'agent', x: 3, y: 4, cmd: 'envman -e work -- claude', agentId: 'claude', name: 'Kiwi' },
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

test('getSettings returns defaults before anything is saved', () => {
  const db = freshDb()
  expect(db.getSettings().fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  expect(db.getSettings().customAgents.length).toBe(0)
})

test('saveSettings persists a patch and leaves untouched keys at their default', () => {
  const db = freshDb()
  db.saveSettings({ fontSize: 17, edgeColor: '#ff0000' })
  expect(db.getSettings().fontSize).toBe(17)
  expect(db.getSettings().edgeColor).toBe('#ff0000')
  expect(db.getSettings().gridSize).toBe(DEFAULT_SETTINGS.gridSize)
})

test('skill cable color and size persist, and an unknown value reads back as the default', () => {
  const db = freshDb()
  expect(db.getSettings()).toMatchObject({ skillCableColor: 'default', skillCableSize: 'normal' })
  db.saveSettings({ skillCableColor: 'teal', skillCableSize: 'thick' })
  expect(db.getSettings()).toMatchObject({ skillCableColor: 'teal', skillCableSize: 'thick' })
  db.saveSettings({ skillCableColor: '#ff0000', skillCableSize: 'huge' as never })
  expect(db.getSettings()).toMatchObject({ skillCableColor: 'default', skillCableSize: 'normal' })
})

test('a second patch merges over the first instead of replacing it', () => {
  const db = freshDb()
  db.saveSettings({ fontSize: 17 })
  db.saveSettings({ cursorBlink: false })
  expect(db.getSettings().fontSize).toBe(17)
  expect(db.getSettings().cursorBlink).toBe(false)
})

test('saveSettings drops unknown keys and wrong-shaped values', () => {
  const db = freshDb()
  const got = db.saveSettings({ fontSize: 'huge', nope: 1, customAgents: { not: 'an array' } })
  expect(got.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  expect(Array.isArray(got.customAgents)).toBe(true)
  expect('nope' in (got as unknown as Record<string, unknown>)).toBe(false)
})

test('saveSettings keeps keys of a newer build and other workspaces\' entries in the raw row', () => {
  const d = openDb(':memory:')
  const db = new Db(d)
  const bg = DEFAULT_SETTINGS.canvasBackground
  d.query("INSERT INTO app (key, value) VALUES ('settings', ?)").run(JSON.stringify({ futureKey: { v: 2 }, canvasBackgroundByWorkspace: { w1: bg } }))
  db.saveSettings({ canvasBackgroundByWorkspace: { w2: { ...bg, mode: 'gradient' } } })
  db.saveSettings({ fontSize: 18 })
  const raw = JSON.parse((d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string }).value)
  expect(raw.futureKey).toEqual({ v: 2 })
  expect(Object.keys(raw.canvasBackgroundByWorkspace).sort()).toEqual(['w1', 'w2'])
  expect(raw.fontSize).toBe(18)
})

test('settings and the active-workspace id share the app table without colliding', () => {
  const db = freshDb()
  const ws = db.create('proj')
  db.setActive(ws.id)
  db.saveSettings({ fontSize: 19 })
  expect(db.getActive()).toBe(ws.id)
  expect(db.getSettings().fontSize).toBe(19)
})

test('save round-trips bridges intact', () => {
  const db = freshDb()
  const ws = db.create('proj')
  // fresh workspace starts with an empty bridges array
  expect(JSON.stringify(ws.bridges)).toBe('[]')
  const bridges = [{ id: 'b1', source: 'n1', target: 'n2', kind: 'context' as const }]
  ws.bridges = bridges
  db.save(ws)
  const got = db.get(ws.id)
  expect(JSON.stringify(got?.bridges)).toBe(JSON.stringify(bridges))
})
