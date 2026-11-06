// data-209-2 / data-209-3 over real HTTP: a stale board save is 409 with the current board (the
// other window's nodes survive), and a PUT never re-creates a deleted or unknown workspace.
import { test, expect } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'
import { cappedBodyGetter, WORKSPACES_BODY_MAX_BYTES } from './cappedRequestBody'
import { send } from './routes/route.core'
import type { Workspace } from '../shared/workspace'

async function withServer(run: (base: string, store: Db) => Promise<void>): Promise<void> {
  const store = new Db(openDb(':memory:'))
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const method = req.method ?? 'GET'
    void workspacesRoute(store, path, method, cappedBodyGetter(req, method, WORKSPACES_BODY_MAX_BYTES)).then((r) => send(res, r))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store)
  } finally {
    server.close()
  }
}

const put = (base: string, ws: Workspace) =>
  fetch(`${base}/api/workspaces/${ws.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ws) })
const node = (id: string) => ({ id, kind: 'terminal' as const, x: 0, y: 0 })

test('two writers on the same base: the second gets 409 + current, nothing is lost', async () => {
  await withServer(async (base, store) => {
    const loaded = store.create('proj') // both windows loaded this version
    const a = await put(base, { ...loaded, nodes: [node('a1')] })
    expect(a.status).toBe(200)
    const savedA = (await a.json()) as Workspace
    expect(savedA.updatedAt > loaded.updatedAt).toBe(true)

    const b = await put(base, { ...loaded, nodes: [node('b1')] }) // stale: still on `loaded`
    expect(b.status).toBe(409)
    const body = (await b.json()) as { code: string; current: Workspace }
    expect(body.code).toBe('stale')
    expect(body.current.nodes.map((n) => n.id).join()).toBe('a1')
    expect(store.get(loaded.id)?.nodes.map((n) => n.id).join()).toBe('a1')

    // After reloading `current`, window B saves on the fresh base and wins normally.
    const b2 = await put(base, { ...body.current, nodes: [node('a1'), node('b1')] })
    expect(b2.status).toBe(200)
    expect(store.get(loaded.id)?.nodes.map((n) => n.id).join()).toBe('a1,b1')
  })
})

test('back-to-back saves get strictly increasing versions (same millisecond still conflicts)', async () => {
  await withServer(async (base, store) => {
    const loaded = store.create('proj')
    const first = (await (await put(base, { ...loaded, nodes: [node('x')] })).json()) as Workspace
    const second = (await (await put(base, first)).json()) as Workspace
    expect(second.updatedAt > first.updatedAt).toBe(true)
    expect((await put(base, first)).status).toBe(409) // `first` is now one version behind
  })
})

test('PUT after DELETE is 404 and does not resurrect the workspace', async () => {
  await withServer(async (base, store) => {
    const doomed = store.create('doomed')
    const del = await fetch(`${base}/api/workspaces/${doomed.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    const r = await put(base, { ...doomed, nodes: [node('ghost')] })
    expect(r.status).toBe(404)
    expect(store.list().length).toBe(0)
  })
})

test('PUT for an id that never existed is 404, not a create', async () => {
  await withServer(async (base, store) => {
    const r = await put(base, { ...store.create('other'), id: 'never-created' })
    expect(r.status).toBe(404)
    expect(store.get('never-created')).toBe(null)
  })
})
