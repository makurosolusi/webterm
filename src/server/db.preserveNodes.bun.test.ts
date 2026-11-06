// Data-loss lock: a stored node this build cannot read (newer build's kind, broken shape) is hidden
// from the served board but survives every write of the row, and its id stays known to the orphan
// reaper. Real SQLite in memory; the policy tests pin every `nodes` writer to `Db.nodesColumn`.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../shared/workspace'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'

const TERM: WsNode = { id: 't1', kind: 'terminal', x: 1, y: 2 }
const FUTURE = { id: 'x', kind: 'futureKind', position: { x: 5, y: 6 }, extra: { deep: [1, 'two'] } }
const BROKEN = { id: 'b1', kind: 'agent', x: 'far', y: 0 }
const HIDDEN = [FUTURE, BROKEN].map((n) => JSON.stringify(n))

function seeded(): { store: Db; d: ReturnType<typeof openDb>; ws: Workspace } {
  const d = openDb(':memory:')
  const store = new Db(d)
  const ws = store.create('p')
  d.query('UPDATE workspace SET nodes = ? WHERE id = ?').run(JSON.stringify([TERM, FUTURE, BROKEN, 'junk']), ws.id)
  return { store, d, ws: store.get(ws.id)! }
}

const rawNodes = (d: ReturnType<typeof openDb>, id: string): unknown[] =>
  JSON.parse((d.query('SELECT nodes FROM workspace WHERE id = ?').get(id) as { nodes: string }).nodes)
const rawHidden = (d: ReturnType<typeof openDb>, id: string): string[] =>
  rawNodes(d, id).filter((n) => (n as { id?: string }).id !== TERM.id).map((n) => JSON.stringify(n))

test('list/get serve only the readable node; the row still holds the unreadable ones', () => {
  const { store, d, ws } = seeded()
  expect(store.list().find((w) => w.id === ws.id)?.nodes).toEqual([TERM])
  expect(ws.nodes).toEqual([TERM])
  expect(rawHidden(d, ws.id)).toEqual([...HIDDEN, JSON.stringify('junk')])
})

test('saving with the terminal moved keeps both unreadable nodes byte-identical; id-less junk is dropped', () => {
  const { store, d, ws } = seeded()
  expect(store.save({ ...ws, nodes: [{ ...TERM, x: 50 }] }, ws.updatedAt)).toBe('saved')
  expect(rawHidden(d, ws.id)).toEqual(HIDDEN)
  expect(store.get(ws.id)?.nodes).toEqual([{ ...TERM, x: 50 }])
})

test('saving with the terminal removed still keeps them, across repeated saves', () => {
  const { store, d, ws } = seeded()
  expect(store.save({ ...ws, nodes: [] })).toBe('saved')
  expect(store.save({ ...store.get(ws.id)!, nodes: [] })).toBe('saved')
  expect(rawNodes(d, ws.id).map((n) => JSON.stringify(n))).toEqual(HIDDEN)
  expect(store.get(ws.id)?.nodes).toEqual([])
})

test('an incoming node with the same id replaces the preserved one', () => {
  const { store, d, ws } = seeded()
  const x: WsNode = { id: 'x', kind: 'terminal', x: 7, y: 8 }
  expect(store.save({ ...ws, nodes: [TERM, x] })).toBe('saved')
  expect(rawNodes(d, ws.id)).toEqual([TERM, x, BROKEN])
})

test('a stale save writes nothing and keeps the row as it was', () => {
  const { store, d, ws } = seeded()
  const before = JSON.stringify(rawNodes(d, ws.id))
  expect(store.save({ ...ws, nodes: [] }, ws.updatedAt - 1)).toBe('stale')
  expect(JSON.stringify(rawNodes(d, ws.id))).toBe(before)
})

test('the PUT route (client save) carries them through as well', async () => {
  const { store, d, ws } = seeded()
  const body = JSON.stringify({ name: 'p', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: ws.updatedAt })
  const res = await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'PUT', () => Promise.resolve(body))
  expect(res?.status).toBe(200)
  expect((res?.body as Workspace).nodes).toEqual([])
  expect(rawNodes(d, ws.id).map((n) => JSON.stringify(n))).toEqual(HIDDEN)
})

test('nodeIds (the reaper\'s known set) counts preserved node ids; delete removes everything', () => {
  const { store, d, ws } = seeded()
  const other = store.create('q')
  store.save({ ...other, nodes: [{ id: 'o1', kind: 'files', x: 0, y: 0 }] })
  expect(store.nodeIds().sort()).toEqual(['b1', 'o1', 't1', 'x'])
  store.delete(ws.id)
  expect(d.query('SELECT 1 FROM workspace WHERE id = ?').get(ws.id)).toBeNull()
  expect(store.nodeIds()).toEqual(['o1'])
})

test('policy: knownNodeIds builds the reaper set from the raw ids, not the served boards', () => {
  const src = readFileSync(join(__dirname, 'sessions.ts'), 'utf8')
  const start = src.indexOf('async function knownNodeIds')
  const fn = src.slice(start, src.indexOf('\n}\n', start))
  expect(start).toBeGreaterThan(-1)
  expect(fn).toContain('db.nodeIds()')
  expect(fn).not.toContain('db.list()')
})

function serverSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return serverSources(p)
    return /\.ts$/.test(name) && !/\.test\.ts$|\.testutil\.ts$|\.d\.ts$/.test(name) ? [p] : []
  })
}

test('policy: the workspace table is written only in db.ts, and every write takes nodes from nodesColumn', () => {
  const writesWorkspace = /\b(INSERT INTO|UPDATE|REPLACE INTO)\s+workspace\b/g
  const offenders = serverSources(__dirname).filter((p) => !p.endsWith('/db.ts') && (readFileSync(p, 'utf8').match(writesWorkspace) ?? []).length > 0)
  expect(offenders).toEqual([])
  const src = readFileSync(join(__dirname, 'db.ts'), 'utf8')
  const statements = src.match(writesWorkspace) ?? []
  const viaHelper = src.match(/this\.nodesColumn\(/g) ?? []
  expect(statements.length).toBeGreaterThan(0)
  expect(viaHelper.length).toBe(statements.length)
  expect(src).not.toMatch(/JSON\.stringify\(\w+\.nodes\)/) // a raw serialization would bypass the carry-through
})
