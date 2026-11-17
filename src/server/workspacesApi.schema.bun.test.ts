// data-209-6 + ui-210-7 locks: the shared workspace schema on write (400, row untouched) and on read
// (one corrupt row degrades only itself), post-commit side effects never change the status, and
// create validates name + cwd. Real SQLite in memory, temp dirs for cwd.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'
import { AGENT_CHAT_KIND } from '../shared/agentChat.shape'
import { normalizeWorkspace } from '../shared/workspace.schema'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'

const dir = mkdtempSync(join(tmpdir(), 'wt-wsschema-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withBody = (v: unknown) => () => Promise.resolve(JSON.stringify(v))
const noBody = () => Promise.resolve('')
const put = (store: Db, id: string, v: unknown) => workspacesRoute(store, `/api/workspaces/${id}`, 'PUT', withBody(v))
const post = (store: Db, v: unknown) => workspacesRoute(store, '/api/workspaces', 'POST', withBody(v))
const NODE = { id: 'n1', kind: 'terminal', name: 'Mango', x: 1, y: 2 }
const VALID = { name: 'p', viewport: DEFAULT_VIEWPORT, nodes: [NODE] }

test('malformed PUT bodies are 400 naming the field, and the stored row stays unchanged', async () => {
  const store = new Db(openDb(':memory:'))
  const ws = store.create('p')
  expect((await put(store, ws.id, VALID))?.status).toBe(200)
  const before = JSON.stringify(store.get(ws.id))
  const cases: [string, unknown][] = [
    ['nodes', { ...VALID, nodes: { evil: 1 } }],
    ['nodes', { name: 'p', viewport: DEFAULT_VIEWPORT }],
    ['viewport', { ...VALID, viewport: 'nope' }],
    ['viewport', { name: 'p', nodes: [] }],
    ['viewport', { ...VALID, viewport: { x: 0, y: 0, zoom: 0 } }],
    ['name', { ...VALID, name: '' }],
    ['name', { ...VALID, name: 42 }],
    ['bridges', { ...VALID, bridges: 'x' }],
    ['bridges[0]', { ...VALID, bridges: [{ id: 'b' }] }],
    ['nodes[0]', { ...VALID, nodes: [{ ...NODE, kind: 'rocket' }] }],
    ['nodes[1]', { ...VALID, nodes: [NODE, { id: 'n2', kind: 'agent', x: 'far', y: 0 }] }],
    ['nodes[0]', { ...VALID, nodes: [null] }],
    ['cwd', { ...VALID, cwd: 7 }],
  ]
  for (const [field, body] of cases) {
    const r = await put(store, ws.id, body)
    const issues = (r?.body as { issues?: string[] } | undefined)?.issues ?? []
    expect(`${field}:${r?.status}`).toBe(`${field}:400`)
    expect(issues.some((i) => i.startsWith(field))).toBe(true)
    expect(JSON.stringify(store.get(ws.id))).toBe(before)
  }
})

test('a valid PUT keeps unknown node fields and sanitizes the node blobs it knows', async () => {
  const store = new Db(openDb(':memory:'))
  const ws = store.create('p')
  const node = { ...NODE, futureField: { a: 1 }, diffNotes: [{ id: 'd', path: 'a.ts', line: 1, body: 'ok' }, { bad: 1 }] }
  expect((await put(store, ws.id, { ...VALID, nodes: [node] }))?.status).toBe(200)
  const saved = store.get(ws.id)?.nodes[0] as unknown as Record<string, unknown>
  expect(saved.futureField).toEqual({ a: 1 })
  expect(saved.diffNotes).toEqual([{ id: 'd', path: 'a.ts', line: 1, body: 'ok' }])
})

test('an agent chat node round-trips through the schema, a PUT and a load without a downgrade', async () => {
  const chat = { id: 'c1', kind: AGENT_CHAT_KIND, name: 'Kiwi', x: 3, y: 4, title: 'chat' }
  const board = { ...VALID, nodes: [NODE, chat] }
  expect(normalizeWorkspace(board)).toEqual({ board: { ...board, cwd: undefined, color: undefined, bridges: [] }, issues: [], preserved: [] })
  const store = new Db(openDb(':memory:'))
  const ws = store.create('p')
  expect((await put(store, ws.id, board))?.status).toBe(200)
  expect(store.get(ws.id)?.nodes).toEqual([NODE, chat])
  expect(store.list().find((w) => w.id === ws.id)?.nodes).toEqual([NODE, chat])
})

test('a corrupt row still lets list() return every other workspace; the bad one degrades alone', () => {
  const d = openDb(':memory:')
  const store = new Db(d)
  const good = store.create('good')
  const bad = store.create('bad')
  const mixed = store.create('mixed')
  d.query("UPDATE workspace SET nodes = '[{\"id\":\"n1\",\"kind\":\"term', viewport = 'nope', bridges = '{' WHERE id = ?").run(bad.id)
  d.query('UPDATE workspace SET nodes = ? WHERE id = ?').run(JSON.stringify([NODE, { id: 'x' }, 'junk']), mixed.id)
  const all = store.list()
  expect(all.map((w) => w.id).sort()).toEqual([good.id, bad.id, mixed.id].sort())
  const byId = new Map(all.map((w) => [w.id, w]))
  expect(byId.get(bad.id)?.nodes).toEqual([])
  expect(byId.get(bad.id)?.viewport).toEqual(DEFAULT_VIEWPORT)
  expect(byId.get(bad.id)?.bridges).toEqual([])
  expect(byId.get(mixed.id)?.nodes).toEqual([NODE])
  expect(store.get(bad.id)?.name).toBe('bad')
})

test('a post-commit side effect that throws never turns a stored save into a 500', async () => {
  // A store whose previous board is malformed (a writer that bypassed the schema): the save log
  // used to throw `.map is not a function` AFTER the commit, answering 500 for a stored write.
  const saved: Workspace[] = []
  const prev = { id: 'ws1', name: 'p', viewport: DEFAULT_VIEWPORT, nodes: { evil: 1 }, bridges: 'x', updatedAt: 1 }
  const store = {
    get: () => (saved.length ? saved[saved.length - 1] : prev),
    save: (ws: Workspace) => { saved.push(ws); return 'saved' },
  } as unknown as Db
  const r = await put(store, 'ws1', VALID)
  expect(r?.status).toBe(200)
  expect(saved).toHaveLength(1)
})

test('POST create: empty name and a cwd that is not an existing directory are 400 with a message', async () => {
  const store = new Db(openDb(':memory:'))
  const file = join(dir, 'a-file')
  writeFileSync(file, 'x')
  const cases: [unknown, string][] = [
    [{ name: '' }, 'name must be a non-empty string'],
    [{ name: '   ' }, 'name must be a non-empty string'],
    [{}, 'name must be a non-empty string'],
    [{ name: 'p', cwd: join(dir, 'missing') }, 'cwd must be an existing directory'],
    [{ name: 'p', cwd: file }, 'cwd must be an existing directory'],
    [{ name: 'p', cwd: 5 }, 'cwd must be an existing directory'],
    [{ name: 'p', color: 5 }, 'color must be a palette hue id'],
  ]
  for (const [body, error] of cases) {
    const r = await post(store, body)
    expect(r?.status).toBe(400)
    expect((r?.body as { error: string }).error).toBe(error)
  }
  expect(store.list()).toHaveLength(0)
  const ok = await post(store, { name: '  proj  ', cwd: dir })
  expect(ok?.status).toBe(201)
  expect((ok?.body as Workspace).name).toBe('proj')
  expect((await post(store, { name: 'no cwd', cwd: '' }))?.status).toBe(201)
  expect(((await workspacesRoute(store, '/api/workspaces', 'GET', noBody))?.body as Workspace[]).length).toBe(2)
})
