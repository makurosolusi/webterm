// data-209-12 lock: `GET /api/workspaces?summary=1` pages a geometry-free view with limit + an
// opaque keyset cursor; without `summary=1` the full list is unchanged. Real SQLite in memory.
import { expect, test } from 'bun:test'
import type { Workspace } from '../shared/workspace'
import type { WorkspaceSummaryPage } from '../shared/workspace.summary'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'

const noBody = () => Promise.resolve('')
const get = (store: Db, qs: string) =>
  workspacesRoute(store, '/api/workspaces', 'GET', noBody, undefined, new URLSearchParams(qs))

function seeded(count: number): { store: Db; ids: string[] } {
  const d = openDb(':memory:')
  const store = new Db(d)
  for (let i = 0; i < count; i++) {
    const ws = store.create(`w${i}`)
    store.save({ ...ws, nodes: [{ id: `n${i}`, kind: 'agent', x: 10, y: 20, width: 300, title: 'T', agentId: 'claude', cmd: 'claude' }] })
  }
  // Every row on the SAME timestamp: the id tiebreak alone must keep pages disjoint and complete.
  d.exec('UPDATE workspace SET updated_at = 1000')
  return { store, ids: store.list().map((w) => w.id) }
}

test('summary omits viewport/layout/bridges and node geometry, and honours limit', async () => {
  const { store } = seeded(3)
  const r = await get(store, 'summary=1&limit=2')
  expect(r?.status).toBe(200)
  const page = JSON.parse(JSON.stringify(r?.body)) as WorkspaceSummaryPage // what the wire carries
  expect(page.items).toHaveLength(2)
  expect(typeof page.nextCursor).toBe('string')
  for (const item of page.items) {
    expect(Object.keys(item).sort()).toEqual(['color', 'colorShade', 'id', 'name', 'nodes', 'updatedAt'])
    expect(Object.keys(item.nodes[0] ?? {}).sort()).toEqual(['agentId', 'id', 'kind', 'name', 'title'])
  }
  expect(JSON.stringify(page)).not.toMatch(/viewport|layout|bridges|"x"|width|cmd/)
})

test('cursor pages are disjoint, complete and stable (updatedAt DESC, id DESC) even on equal timestamps', async () => {
  const { store, ids } = seeded(5)
  const seen: string[] = []
  let cursor: string | undefined
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const page = (await get(store, `summary=1&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))?.body as WorkspaceSummaryPage
    seen.push(...page.items.map((w) => w.id))
    cursor = page.nextCursor
    if (!cursor) break
  }
  expect(seen).toEqual([...ids].sort().reverse())
  expect(new Set(seen).size).toBe(5)
})

test('default limit is 50; the last page has no nextCursor', async () => {
  const { store } = seeded(3)
  const page = (await get(store, 'summary=1'))?.body as WorkspaceSummaryPage
  expect(page.items).toHaveLength(3)
  expect(page.nextCursor === undefined).toBe(true)
})

test('bad limit or cursor is 400; without summary=1 the full list is unchanged', async () => {
  const { store } = seeded(2)
  for (const qs of ['summary=1&limit=0', 'summary=1&limit=201', 'summary=1&limit=x', 'summary=1&limit=1.5', 'summary=1&cursor=nope', `summary=1&cursor=${Buffer.from('[1]').toString('base64url')}`]) {
    expect(`${qs}:${(await get(store, qs))?.status}`).toBe(`${qs}:400`)
  }
  const full = (await get(store, ''))?.body as Workspace[]
  expect(JSON.stringify(full)).toBe(JSON.stringify(store.list()))
  expect(full[0]?.viewport).toBeDefined()
  expect(full[0]?.layout).toBeDefined()
})
