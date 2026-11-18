// Bun-only (bun:sqlite). Persisted workspace order: migration + backfill, stable order, reorder
// validation/atomicity, delete compaction, append on create, the `PUT /api/workspaces/order` route and its WS push.
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'
import { registerCanvasBroadcast } from './canvas/canvasPush.runtime'

const fresh = (): Db => new Db(openDb(':memory:'))
const ids = (db: Db): string[] => db.list().map((w) => w.id)
const noBody = () => Promise.resolve('')
const withBody = (v: unknown) => () => Promise.resolve(JSON.stringify(v))

/** Three workspaces whose `updated_at` order (c newest, b, a oldest) is the pre-migration display order. */
function legacyDb(path: string): void {
  const d = new Database(path)
  d.exec(`CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, color TEXT,
    viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}', nodes TEXT NOT NULL DEFAULT '[]', bridges TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)`)
  for (const [id, at] of [['a', 100], ['b', 200], ['c', 300]] as const) d.query('INSERT INTO workspace (id, name, updated_at) VALUES (?, ?, ?)').run(id, id, at)
  d.close()
}

test('migration backfills the order users saw (updated_at DESC), and a second boot changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsorder-'))
  try {
    const path = join(dir, 'webterm.db')
    legacyDb(path)
    const first = new Db(openDb(path))
    expect(ids(first)).toEqual(['c', 'b', 'a'])
    expect(first.list().map((w) => w.position)).toEqual([0, 1, 2])
    first.reorder(['a', 'c', 'b'])
    first.close()
    const second = new Db(openDb(path)) // boot again: neither the table nor the backfill may touch the stored order
    expect(ids(second)).toEqual(['a', 'c', 'b'])
    second.close()
    const raw = new Database(path)
    expect((raw.query('SELECT COUNT(*) AS n FROM workspace_position').get() as { n: number }).n).toBe(3)
    raw.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('new workspaces go to the end and editing a board never moves it', () => {
  const db = fresh()
  const [a, b, c] = [db.create('a'), db.create('b'), db.create('c')]
  expect(ids(db)).toEqual([a.id, b.id, c.id])
  expect([a.position, b.position, c.position]).toEqual([0, 1, 2])
  db.save({ ...a, name: 'a edited' }) // bumps updated_at: under the old rule a would jump to the front
  db.setColor(b.id, 'red', 'vivid')
  expect(ids(db)).toEqual([a.id, b.id, c.id])
  expect(db.get(a.id)?.position).toBe(0)
})

test('reorder stores the full order, keeps updated_at, and listSummaries carries position', () => {
  const db = fresh()
  const [a, b, c] = [db.create('a'), db.create('b'), db.create('c')]
  const before = db.get(a.id)?.updatedAt
  expect(db.reorder([c.id, a.id, b.id])).toEqual({ ok: true })
  expect(ids(db)).toEqual([c.id, a.id, b.id])
  expect(db.get(a.id)?.updatedAt).toBe(before)
  expect(db.listSummaries(10).items.map((s) => [s.id, s.position]).sort()).toEqual([[a.id, 1], [b.id, 2], [c.id, 0]].sort())
})

test('reorder refuses duplicates, unknown ids and missing ids, and changes nothing', () => {
  const db = fresh()
  const [a, b, c] = [db.create('a'), db.create('b'), db.create('c')]
  const keep = [a.id, b.id, c.id]
  expect(db.reorder([a.id, a.id, b.id])).toEqual({ ok: false, reason: 'duplicate' })
  expect(db.reorder([c.id, b.id, 'ghost'])).toEqual({ ok: false, reason: 'unknown' })
  expect(db.reorder([c.id, b.id])).toEqual({ ok: false, reason: 'missing' })
  expect(db.reorder([c.id, b.id, a.id, 'ghost'])).toEqual({ ok: false, reason: 'unknown' })
  expect(ids(db)).toEqual(keep)
})

test('reorder is atomic: a failure inside the write rolls the whole order back', () => {
  const d = openDb(':memory:')
  const db = new Db(d)
  const [a, b] = [db.create('a'), db.create('b')]
  // A trigger that rejects position 0 on UPDATE makes the batch upsert fail after the first row is applied.
  d.exec("CREATE TRIGGER boom BEFORE UPDATE ON workspace_position WHEN NEW.position = 0 BEGIN SELECT RAISE(ABORT, 'boom'); END")
  let failed = false
  try { db.reorder([b.id, a.id]) } catch { failed = true } // the trigger's error must surface
  expect(failed).toBe(true)
  expect(ids(db)).toEqual([a.id, b.id])
  expect(db.list().map((w) => w.position)).toEqual([0, 1])
})

test('delete closes the gap and keeps the relative order', () => {
  const db = fresh()
  const [a, b, c, d] = [db.create('a'), db.create('b'), db.create('c'), db.create('d')]
  db.reorder([d.id, b.id, a.id, c.id])
  db.delete(b.id)
  expect(ids(db)).toEqual([d.id, a.id, c.id])
  expect(db.list().map((w) => w.position)).toEqual([0, 1, 2])
  expect(db.create('e').position).toBe(3)
})

test('PUT /api/workspaces/order: 200 + ordered list + one ws push with the order', async () => {
  const sent: ServerMsg[] = []
  registerCanvasBroadcast((m) => { sent.push(m) })
  const db = fresh()
  const [a, b] = [db.create('a'), db.create('b')]
  const r = await workspacesRoute(db, '/api/workspaces/order', 'PUT', withBody({ ids: [b.id, a.id] }))
  expect(r?.status).toBe(200)
  expect((r?.body as { id: string }[]).map((w) => w.id)).toEqual([b.id, a.id])
  expect(sent).toEqual([{ t: 'workspaces', order: [b.id, a.id] }])
  const list = await workspacesRoute(db, '/api/workspaces', 'GET', noBody)
  expect((list?.body as { id: string; position: number }[]).map((w) => [w.id, w.position])).toEqual([[b.id, 0], [a.id, 1]])
})

test('PUT /api/workspaces/order: 400 bad_order with a reason, nothing stored, no push', async () => {
  const sent: ServerMsg[] = []
  registerCanvasBroadcast((m) => { sent.push(m) })
  const db = fresh()
  const [a, b] = [db.create('a'), db.create('b')]
  const cases: [unknown, string][] = [
    [{}, 'shape'], [{ ids: 'x' }, 'shape'], [{ ids: [1] }, 'shape'], [{ ids: [a.id, a.id] }, 'duplicate'],
    [{ ids: [a.id, 'ghost'] }, 'unknown'], [{ ids: [a.id] }, 'missing'],
  ]
  for (const [body, reason] of cases) {
    const r = await workspacesRoute(db, '/api/workspaces/order', 'PUT', withBody(body))
    expect([r?.status, r?.body]).toEqual([400, { error: 'bad_order', reason }])
  }
  expect(ids(db)).toEqual([a.id, b.id])
  expect(sent).toEqual([])
})
