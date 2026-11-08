// Migration (workspace.layout column) + API round-trip. Bun-only: needs bun:sqlite.
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'
import { defaultTabLayout, FILES_PANEL_WIDTH, type TabLayout } from '../shared/tabLayout.schema'

const NODES = [{ id: 'n1', kind: 'terminal', name: 'Mango', x: 1, y: 2 }, { id: 'n2', kind: 'files', name: 'Kiwi', x: 3, y: 4 }]
const BRIDGES = [{ id: 'e1', source: 'n1', target: 'n2', kind: 'context' }]

const tabsLayout = (): TabLayout => ({
  mode: 'tabs',
  tabs: { order: ['n1'], active: 'n1', filesPanel: { open: false, width: FILES_PANEL_WIDTH.min } },
})

/** A database exactly as the previous release left it: workspace table WITHOUT `layout`. */
function legacyDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'wt-layout-')), 'webterm.db')
  const d = new Database(path)
  d.exec(`CREATE TABLE workspace (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, color TEXT,
    viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
    nodes TEXT NOT NULL DEFAULT '[]', bridges TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);`)
  d.query('INSERT INTO workspace VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old', 'legacy', '/tmp', '#fff', '{"x":5,"y":6,"zoom":2}', JSON.stringify(NODES), JSON.stringify(BRIDGES), 42)
  return path
}

test('migration: legacy data survives, layout backfills to canvas default, 2nd run is a no-op', () => {
  const path = legacyDb()
  for (const _ of [1, 2]) {
    const d = openDb(path)
    const ws = new Db(d).get('old')
    expect(JSON.stringify(ws?.nodes)).toBe(JSON.stringify(NODES))
    expect(JSON.stringify(ws?.bridges)).toBe(JSON.stringify(BRIDGES))
    expect(JSON.stringify(ws?.viewport)).toBe('{"x":5,"y":6,"zoom":2}')
    expect([ws?.name, ws?.cwd, ws?.color, ws?.updatedAt]).toEqual(['legacy', '/tmp', '#fff', 42])
    expect(JSON.stringify(ws?.layout)).toBe(JSON.stringify(defaultTabLayout()))
    const cols = (d.query('PRAGMA table_info(workspace)').all() as { name: string }[]).filter((c) => c.name === 'layout')
    expect(cols.length).toBe(1)
  }
})

test('a corrupt layout cell reads back as the canvas default instead of breaking the board', () => {
  const d = openDb(':memory:')
  const store = new Db(d)
  const ws = store.create('p')
  d.query("UPDATE workspace SET layout = '{not json' WHERE id = ?").run(ws.id)
  expect(JSON.stringify(store.get(ws.id)?.layout)).toBe(JSON.stringify(defaultTabLayout()))
})

const put = (store: Db, id: string, body: unknown) =>
  workspacesRoute(store, `/api/workspaces/${id}`, 'PUT', () => Promise.resolve(JSON.stringify(body)))

test('API: layout round-trips, and saving nodes without layout keeps it (no clobber)', async () => {
  const store = new Db(openDb(':memory:'))
  const ws = store.create('p')
  const base = { name: 'p', viewport: ws.viewport, nodes: NODES, bridges: BRIDGES }

  const saved = await put(store, ws.id, { ...base, layout: tabsLayout() })
  expect(JSON.stringify((saved?.body as { layout: TabLayout }).layout)).toBe(JSON.stringify(tabsLayout()))
  expect(JSON.stringify(store.get(ws.id)?.layout)).toBe(JSON.stringify(tabsLayout()))

  // Old client / partial writer: no `layout` key -> stored layout stays, nodes are updated.
  const moved = [{ id: 'n1', kind: 'terminal', name: 'Mango', x: 99, y: 2 }]
  await put(store, ws.id, { ...base, nodes: moved })
  const after = store.get(ws.id)
  expect(JSON.stringify(after?.layout)).toBe(JSON.stringify(tabsLayout()))
  expect(JSON.stringify(after?.nodes)).toBe(JSON.stringify(moved))

  // Saving only the layout leaves nodes/bridges/viewport untouched.
  await put(store, ws.id, { ...base, nodes: moved, layout: { ...tabsLayout(), mode: 'canvas' } })
  const last = store.get(ws.id)
  expect(last?.layout?.mode).toBe('canvas')
  expect(JSON.stringify(last?.nodes)).toBe(JSON.stringify(moved))
  expect(JSON.stringify(last?.bridges)).toBe(JSON.stringify(BRIDGES))

  // GET returns the same layout as the stored one.
  const got = await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'GET', () => Promise.resolve(''))
  expect(JSON.stringify((got?.body as { layout: TabLayout }).layout)).toBe(JSON.stringify(last?.layout))
})

test('API: a dirty layout in the PUT body is sanitized before it is stored', async () => {
  const store = new Db(openDb(':memory:'))
  const ws = store.create('p')
  await put(store, ws.id, { name: 'p', viewport: ws.viewport, nodes: [], layout: { mode: 'weird', tabs: { order: ['a', 'a', 3], active: 'zz', filesPanel: { width: 1e9 } } } })
  const l = store.get(ws.id)?.layout
  expect(l?.mode).toBe('canvas')
  expect(JSON.stringify(l?.tabs.order)).toBe('["a"]')
  expect(l?.tabs.active).toBe(null)
  expect(l?.tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.max)
})
