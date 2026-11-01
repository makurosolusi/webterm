// Body intake `/api/workspaces*` + `/api/active`: cap 1 MiB ditegakkan SAAT streaming, dan body
// GET/DELETE tidak pernah menyentuh stream. Store di sini palsu (in-memory) supaya suite node-env
// tidak perlu `bun:sqlite`; cap-nya sendiri diuji lewat request palsu berbentuk stream Node.
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Workspace } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Db } from './db'
import { BodyReadError, cappedBodyGetter, WORKSPACES_BODY_MAX_BYTES } from './cappedRequestBody'
import { fsApiRoute } from './fsApi'
import { workspacesRoute } from './workspacesApi'

const CAP = WORKSPACES_BODY_MAX_BYTES

/** Store minimal dengan permukaan `Db` yang dipakai rute workspace saja. */
function fakeStore(): Db & { creates: number } {
  const rows = new Map<string, Workspace>()
  let active: string | null = null
  let seq = 0
  const store = {
    creates: 0,
    list: () => [...rows.values()],
    get: (id: string) => rows.get(id) ?? null,
    create(name: string, cwd?: string, color?: string) {
      store.creates += 1
      const ws: Workspace = {
        id: `ws${++seq}`, name, cwd, color,
        viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: Date.now(),
      }
      rows.set(ws.id, ws)
      return ws
    },
    save: (ws: Workspace) => void rows.set(ws.id, ws),
    delete: (id: string) => void rows.delete(id),
    getActive: () => active,
    setActive: (id: string) => { active = id },
  }
  return store as unknown as Db & { creates: number }
}

interface TrackedReq extends IncomingMessage {
  /** Berapa kali route berlangganan 'data' — 0 membuktikan stream tidak dibaca. */
  dataSubscriptions: number
  resumes: number
}

/** Request palsu: emitter 'data'/'end' + headers + resume, persis yang dilihat pembaca cap. */
function trackedReq(method: string, headers: Record<string, string> = {}): TrackedReq {
  const req = new EventEmitter() as unknown as TrackedReq
  const on = req.on.bind(req)
  Object.assign(req, { method, headers, dataSubscriptions: 0, resumes: 0 })
  ;(req as unknown as { on: typeof on }).on = (event: string, listener: (...a: unknown[]) => void) => {
    if (event === 'data') req.dataSubscriptions += 1
    return on(event, listener)
  }
  ;(req as unknown as { resume: () => void }).resume = () => { req.resumes += 1 }
  return req
}

/** Kirim chunk SETELAH tick ini, supaya listener-nya sudah terpasang saat rute membaca. */
function feed(req: IncomingMessage, chunks: string[], then: 'end' | 'error' = 'end'): void {
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    if (then === 'end') req.emit('end')
    else req.emit('error', new Error('socket hang up'))
  })
}

/** JSON sah yang panjang byte-nya PERSIS `targetBytes` (spasi di ekor diabaikan `JSON.parse`). */
function jsonOfSize(value: unknown, targetBytes: number): string {
  const json = JSON.stringify(value)
  return json + ' '.repeat(targetBytes - json.length)
}

describe('cap body /api/workspaces', () => {
  it('body chunked di atas cap dijawab 413 tanpa menjalankan handler', async () => {
    const store = fakeStore()
    const req = trackedReq('POST')
    feed(req, [jsonOfSize({ name: 'p' }, CAP + 1)])
    const res = await workspacesRoute(store, '/api/workspaces', 'POST', cappedBodyGetter(req, 'POST', CAP))
    expect(res?.status).toBe(413)
    expect(res?.body).toEqual({ error: 'payload_too_large' })
    expect(store.creates).toBe(0) // handler tidak pernah jalan
  })

  it('Content-Length di atas cap ditolak SEBELUM satu byte dibaca', async () => {
    const store = fakeStore()
    const req = trackedReq('POST', { 'content-length': String(CAP + 1) })
    // Tidak ada chunk sama sekali: kalau reader menunggu 'end', test ini menggantung.
    const res = await workspacesRoute(store, '/api/workspaces', 'POST', cappedBodyGetter(req, 'POST', CAP))
    expect(res?.status).toBe(413)
    expect(res?.body).toEqual({ error: 'payload_too_large' })
    expect(req.dataSubscriptions).toBe(0)
    expect(req.resumes).toBe(1) // sisa body di-drain supaya keep-alive tidak desync
    expect(store.creates).toBe(0)
  })

  it('body tepat sebesar cap tetap diterima', async () => {
    const store = fakeStore()
    const body = jsonOfSize({ name: 'proj', cwd: '/tmp' }, CAP)
    expect(Buffer.byteLength(body)).toBe(CAP)
    const req = trackedReq('POST', { 'content-length': String(CAP) })
    feed(req, [body.slice(0, CAP / 2), body.slice(CAP / 2)])
    const res = await workspacesRoute(store, '/api/workspaces', 'POST', cappedBodyGetter(req, 'POST', CAP))
    expect(res?.status).toBe(201)
    expect(store.creates).toBe(1)
  })

  it('GET tidak membaca stream sama sekali', async () => {
    const store = fakeStore()
    const req = trackedReq('GET')
    const res = await workspacesRoute(store, '/api/workspaces', 'GET', cappedBodyGetter(req, 'GET', CAP))
    expect(res?.status).toBe(200)
    expect(req.dataSubscriptions).toBe(0)
    expect(req.resumes).toBe(0)
  })
})

describe('kegagalan baca body dipetakan ke status', () => {
  it('stream error jadi 400 body_read_failed', async () => {
    const store = fakeStore()
    const req = trackedReq('POST')
    feed(req, ['{"name":"p"}'], 'error')
    const res = await workspacesRoute(store, '/api/workspaces', 'POST', cappedBodyGetter(req, 'POST', CAP))
    expect(res?.status).toBe(400)
    expect(res?.body).toEqual({ error: 'body_read_failed' })
  })

  it('penolakan cap dari getter mana pun jadi 413, bukan bad json', async () => {
    const store = fakeStore()
    const body = () => Promise.reject(new BodyReadError('too_large'))
    expect((await workspacesRoute(store, '/api/active', 'PUT', body))?.status).toBe(413)
  })

  it('error tak terduga dibiarkan naik, tidak disamarkan jadi 400/413', async () => {
    const store = fakeStore()
    const body = () => Promise.reject(new Error('bug di getter'))
    await expect(workspacesRoute(store, '/api/active', 'PUT', body)).rejects.toThrow('bug di getter')
  })
})

// Reader `/api/fs/*` sengaja TIDAK berbatas: menulis file besar itu sah. Test ini mengunci
// keputusan itu — body 2x cap workspace harus tetap tersimpan utuh.
describe('rute fs tetap tanpa cap', () => {
  let dir = ''
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'wt-fs-uncapped-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('menulis file 2 MiB lewat /api/fs/write', async () => {
    const target = join(dir, 'big.txt')
    const content = 'x'.repeat(CAP * 2)
    const raw = JSON.stringify({ path: target, content })
    expect(Buffer.byteLength(raw)).toBeGreaterThan(CAP)
    const res = await fsApiRoute('/api/fs/write', 'POST', new URLSearchParams(), () => Promise.resolve(raw))
    expect(res?.status).toBe(200)
    expect((await readFile(target, 'utf8')).length).toBe(CAP * 2)
  })
})
