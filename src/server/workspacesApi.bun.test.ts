// Bun-only (butuh bun:sqlite lewat `openDb`); jalan di `bun test`, dikecualikan dari vitest lewat
// suffix **/*.bun.test.ts. Hanya toBe/toContain — matcher yang dibuka deklarasi ambient
// src/server/bun-test.d.ts.
import { test, expect } from 'bun:test'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'

function freshStore(): Db {
  return new Db(openDb(':memory:'))
}

/** Getter body untuk request tanpa body; dipanggil hanya oleh POST/PUT. */
const noBody = () => Promise.resolve('')
const withBody = (v: unknown) => () => Promise.resolve(JSON.stringify(v))

test('DELETE /api/workspaces/:id answers 204 and omits body entirely', async () => {
  const store = freshStore()
  const ws = store.create('proj')
  const r = await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'DELETE', noBody)
  expect(r?.status).toBe(204)
  // 'body' in r, bukan r.body === undefined: pemanggil memutuskan tanpa-isi dari ketiadaan kunci.
  expect(r !== null && 'body' in r).toBe(false)
  expect(store.get(ws.id)).toBe(null)
})

test('PUT /api/active answers 204 with no body and stores the id', async () => {
  const store = freshStore()
  const ws = store.create('proj')
  const r = await workspacesRoute(store, '/api/active', 'PUT', withBody({ id: ws.id }))
  expect(r?.status).toBe(204)
  expect(r !== null && 'body' in r).toBe(false)
  expect(store.getActive()).toBe(ws.id)
})

test('POST mints a workspace at 201 and GET lists it', async () => {
  const store = freshStore()
  const created = await workspacesRoute(store, '/api/workspaces', 'POST', withBody({ name: 'proj', cwd: '/tmp' }))
  expect(created?.status).toBe(201)
  const listed = await workspacesRoute(store, '/api/workspaces', 'GET', noBody)
  expect(listed?.status).toBe(200)
  expect(JSON.stringify(listed?.body)).toBe(JSON.stringify([created?.body]))
})

test('PUT /api/workspaces/:id saves nodes and returns the stored snapshot', async () => {
  const store = freshStore()
  const ws = store.create('proj')
  const nodes = [{ id: 'n1', kind: 'terminal', x: 1, y: 2 }]
  const r = await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'PUT', withBody({ name: 'renamed', viewport: ws.viewport, nodes }))
  expect(r?.status).toBe(200)
  expect(JSON.stringify(r?.body)).toBe(JSON.stringify(store.get(ws.id)))
  expect(store.get(ws.id)?.name).toBe('renamed')
})

test('a malformed body is 400, not a crash', async () => {
  const store = freshStore()
  const r = await workspacesRoute(store, '/api/workspaces', 'POST', () => Promise.resolve('{nope'))
  expect(r?.status).toBe(400)
})

// `null`, angka, string, dan array adalah JSON SAH: dulu lolos `JSON.parse`, lalu pembacaan
// properti melempar di runtime dan respons tidak pernah ditutup (client menggantung).
test('a non-object JSON body is 400 on every route that reads one', async () => {
  const store = freshStore()
  const ws = store.create('proj')
  for (const v of [null, 42, 'teks', []]) {
    expect((await workspacesRoute(store, '/api/workspaces', 'POST', withBody(v)))?.status).toBe(400)
    expect((await workspacesRoute(store, `/api/workspaces/${ws.id}`, 'PUT', withBody(v)))?.status).toBe(400)
    expect((await workspacesRoute(store, '/api/active', 'PUT', withBody(v)))?.status).toBe(400)
  }
  // tidak ada yang tertulis: store harus utuh seperti sebelum keempat body itu masuk
  expect(store.get(ws.id)?.name).toBe('proj')
  expect(store.getActive()).toBe(null)
})

// `parseObjectBody` hanya menjamin "ini objek", jadi `{}` dulu lolos, `b.id` adalah `undefined`,
// dan `setActive(undefined)` terikat NULL: 204 SAMBIL menghapus workspace aktif. Yang dikunci di
// sini bukan status code-nya saja tapi invariannya — aktif yang tersimpan harus tetap utuh.
test('PUT /api/active rejects an unusable id at 400 and leaves the stored active intact', async () => {
  const store = freshStore()
  const ws = store.create('proj')
  await workspacesRoute(store, '/api/active', 'PUT', withBody({ id: ws.id }))
  expect(store.getActive()).toBe(ws.id)

  for (const v of [{}, { id: 42 }, { id: null }, { id: '   ' }]) {
    expect((await workspacesRoute(store, '/api/active', 'PUT', withBody(v)))?.status).toBe(400)
    expect(store.getActive()).toBe(ws.id) // tidak tersentuh
  }
})

test('an unknown id is 404 and a foreign path is null so the caller falls through', async () => {
  const store = freshStore()
  expect((await workspacesRoute(store, '/api/workspaces/nope', 'GET', noBody))?.status).toBe(404)
  expect(await workspacesRoute(store, '/api/fs', 'GET', noBody)).toBe(null)
  // method yang tidak dijawab keluarga ini juga null, bukan 405: 404 akhir di api.ts yang menjawab
  expect(await workspacesRoute(store, '/api/active', 'DELETE', noBody)).toBe(null)
})
