// Workspace color: migration + backfill, creation picks an unused hue, the color route validates and
// stores, and a board save can never revert a color. Bun-only (bun:sqlite); toBe/toContain only.
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Db, openDb } from './db'
import { ensureColorColumns } from './db.color'
import { ensureOrderTable } from './db.order'
import { workspacesRoute } from './workspacesApi'
import { WORKSPACE_HUES, backfillWorkspaceHue, isWorkspaceHue } from '../shared/workspaceColor'
import type { ServerMsg } from '../shared/protocol'
import { setWorkspaceColor } from './workspaceColor'

const noBody = () => Promise.resolve('')
const withBody = (v: unknown) => () => Promise.resolve(JSON.stringify(v))
const store = () => new Db(openDb(':memory:'))

test('migration: legacy rows get a deterministic hue, a bad legacy value is replaced, second run is a no-op', () => {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, color TEXT,
    viewport TEXT NOT NULL DEFAULT '{}', nodes TEXT NOT NULL DEFAULT '[]', bridges TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)`)
  d.exec("INSERT INTO workspace (id, name, color, updated_at) VALUES ('a', 'A', NULL, 1), ('b', 'B', '#ff0000', 1), ('c', 'C', 'teal', 1)")
  // Same step order as openDb: `Db.get` (used by setColor) joins workspace_position, so the order table must exist before backfillColors.
  ensureColorColumns(d)
  ensureOrderTable(d)
  new Db(d).backfillColors()
  const read = () => d.query('SELECT id, color, color_shade FROM workspace ORDER BY id').all() as { id: string; color: string; color_shade: string }[]
  const first = read()
  expect(first[0].color).toBe(backfillWorkspaceHue('a'))
  expect(first[1].color).toBe(backfillWorkspaceHue('b'))
  expect(first[2].color).toBe('teal') // a valid hue is kept
  expect(first[0].color_shade).toBe('default')
  ensureColorColumns(d)
  ensureOrderTable(d)
  new Db(d).backfillColors()
  expect(JSON.stringify(read())).toBe(JSON.stringify(first))
})

test('create without a color picks a hue no other workspace uses', () => {
  const s = store()
  const seen = new Set<string>()
  for (let i = 0; i < WORKSPACE_HUES.length; i++) {
    const ws = s.create(`w${i}`)
    expect(isWorkspaceHue(ws.color)).toBe(true)
    expect(seen.has(ws.color as string)).toBe(false)
    seen.add(ws.color as string)
  }
  expect(seen.size).toBe(WORKSPACE_HUES.length)
  expect(isWorkspaceHue(s.create('13th').color)).toBe(true) // all taken: still a valid hue
})

test('POST validates color and shade (400) and stores an explicit choice', async () => {
  const s = store()
  const bad = await workspacesRoute(s, '/api/workspaces', 'POST', withBody({ name: 'x', color: '#ff0000' }))
  expect(bad?.status).toBe(400)
  const badShade = await workspacesRoute(s, '/api/workspaces', 'POST', withBody({ name: 'x', colorShade: 'neon' }))
  expect(badShade?.status).toBe(400)
  const ok = await workspacesRoute(s, '/api/workspaces', 'POST', withBody({ name: 'x', color: 'pink', colorShade: 'vivid' }))
  expect(ok?.status).toBe(201)
  const ws = (ok?.body ?? {}) as { color: string; colorShade: string }
  expect(ws.color).toBe('pink')
  expect(ws.colorShade).toBe('vivid')
})

test('PUT /color validates, stores, keeps the other field, and 404s on an unknown workspace', async () => {
  const s = store()
  const ws = s.create('p', undefined, 'red', 'soft')
  const path = `/api/workspaces/${ws.id}/color`
  expect((await workspacesRoute(s, path, 'PUT', withBody({ color: 'not-a-hue' })))?.status).toBe(400)
  expect((await workspacesRoute(s, path, 'PUT', withBody({ colorShade: 'x' })))?.status).toBe(400)
  expect((await workspacesRoute(s, path, 'PUT', withBody({})))?.status).toBe(400)
  expect((await workspacesRoute(s, '/api/workspaces/nope/color', 'PUT', withBody({ color: 'blue' })))?.status).toBe(404)
  const r = await workspacesRoute(s, path, 'PUT', withBody({ color: 'blue' }))
  expect(r?.status).toBe(200)
  expect(s.get(ws.id)?.color).toBe('blue')
  expect(s.get(ws.id)?.colorShade).toBe('soft') // only the hue changed
  await workspacesRoute(s, path, 'PUT', withBody({ colorShade: 'vivid' }))
  expect(s.get(ws.id)?.colorShade).toBe('vivid')
})

test('a board PUT from a stale copy cannot revert the color, and a color change does not bump updatedAt', async () => {
  const s = store()
  const ws = s.create('p', undefined, 'red')
  const stale = s.get(ws.id)!
  setWorkspaceColor(s, ws.id, { color: 'green' }, () => {})
  expect(s.get(ws.id)?.updatedAt).toBe(stale.updatedAt)
  const r = await workspacesRoute(s, `/api/workspaces/${ws.id}`, 'PUT', withBody({ ...stale, updatedAt: stale.updatedAt }))
  expect(r?.status).toBe(200) // the stale copy still says red and is accepted as a board...
  expect(s.get(ws.id)?.color).toBe('green') // ...but its color is ignored
})

test('setWorkspaceColor broadcasts, random avoids hues used by other workspaces', () => {
  const s = store()
  const a = s.create('a', undefined, 'red')
  for (const h of WORKSPACE_HUES.filter((h) => h !== 'red' && h !== 'blue')) s.create(h, undefined, h)
  const sent: ServerMsg[] = []
  const r = setWorkspaceColor(s, a.id, { random: true }, (m) => sent.push(m), () => 0.99)
  expect(r.ok).toBe(true)
  expect(s.get(a.id)?.color).toBe('blue') // free = a's own red + blue; rand 0.99 takes the last of the pool
  expect(sent.length).toBe(1)
  expect((sent[0] as { t: string }).t).toBe('workspaceColor')
})
