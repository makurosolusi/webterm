// Dispatcher `/api/fs/*` + `fsOps*` terhadap filesystem NYATA, lewat `fsApiRoute` (jalur yang sama
// dengan HTTP): status HTTP bermakna untuk P0 (M-01/M-02/M-05/M-11) dan bentuk verb lama yang tak
// boleh berubah. Bun-only; matcher terbatas toBe/toContain (`bun-test.d.ts`).
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { fsApiRoute } from './fsApi'
import { readErrorResult } from './fsOps'

async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fsapi-'))
  try {
    await fn((...segs: string[]) => npath.join(root, ...segs))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

type Out = { status: number; body: Record<string, unknown> }
const noBody = (): Promise<string> => Promise.resolve('')
/** Meniru `api.ts`: `read`/`read-binary` melempar (kontrak 2) dan route menjawab lewat `readErrorResult`. */
async function get(verb: string, params: Record<string, string>): Promise<Out> {
  try {
    const r = await fsApiRoute(`/api/fs/${verb}`, 'GET', new URLSearchParams(params), noBody)
    return { status: r?.status ?? -1, body: (r?.body ?? {}) as Record<string, unknown> }
  } catch (err) {
    return readErrorResult(err)
  }
}
async function post(verb: string, payload: unknown): Promise<Out> {
  const r = await fsApiRoute(`/api/fs/${verb}`, 'POST', new URLSearchParams(), () => Promise.resolve(JSON.stringify(payload)))
  return { status: r?.status ?? -1, body: (r?.body ?? {}) as Record<string, unknown> }
}
const keys = (o: object): string => JSON.stringify(Object.keys(o).sort())

test('M-01 POST create on an existing name: 409 EEXIST, old content intact', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.txt'), 'ORIGINAL')
    const r = await post('create', { path: at('a.txt'), content: 'new' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('EEXIST')
    expect(await fs.readFile(at('a.txt'), 'utf8')).toBe('ORIGINAL')
    const ok = await post('create', { path: at('b.txt'), content: 'hi' })
    expect(ok.status).toBe(200)
    expect(await fs.readFile(at('b.txt'), 'utf8')).toBe('hi')
  })
})

test('M-02 POST write: stale version 409 EVERSION+current; deleted+mustExist 404 and not recreated', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('f.txt'), 'v1')
    const seen = (await get('read', { path: at('f.txt') })).body.version as string
    await fs.writeFile(at('f.txt'), 'theirs')
    const stale = await post('write', { path: at('f.txt'), content: 'mine', expectedVersion: seen, mustExist: true })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('EVERSION')
    expect(stale.body.current).toBe((await get('read', { path: at('f.txt') })).body.version as string)
    expect(await fs.readFile(at('f.txt'), 'utf8')).toBe('theirs')
    await fs.rm(at('f.txt'))
    const gone = await post('write', { path: at('f.txt'), content: 'mine', mustExist: true })
    expect(gone.status).toBe(404)
    expect(gone.body.code).toBe('ENOENT')
    expect(await fs.access(at('f.txt')).then(() => true, () => false)).toBe(false)
  })
})

test('M-05 read classifies encoding: utf8, binary (empty content), non-utf8 (lossy)', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('t.txt'), 'plain')
    await fs.writeFile(at('b.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x00, 0x01]))
    await fs.writeFile(at('l.txt'), Buffer.from([0x63, 0xe9]))
    expect((await get('read', { path: at('t.txt') })).body.encoding).toBe('utf8')
    const bin = await get('read', { path: at('b.mp3') })
    expect(bin.status).toBe(200)
    expect(bin.body.encoding).toBe('binary')
    expect(bin.body.content).toBe('')
    expect((await get('read', { path: at('l.txt') })).body.encoding).toBe('non-utf8')
  })
})

test('M-11 relative path is 400 EINVAL on v2 verbs and read; NUL path is 400', async () => {
  const rel = await get('read', { path: 'etc/passwd' })
  expect(rel.status === 200).toBe(false)
  expect(rel.status).toBe(400)
  expect((await post('write', { path: 'rel.txt', content: 'x' })).body.code).toBe('EINVAL')
  expect((await get('list-v2', { path: 'rel' })).body.code).toBe('EINVAL')
  expect((await get('stat', { path: '/tmp/a\0b' })).status).toBe(400)
})

test('legacy verbs keep their wire shape (additive fields only)', async () => {
  await withTmp(async (at) => {
    const w = await post('write', { path: at('f.txt'), content: 'héllo' })
    expect(w.status).toBe(200)
    expect(keys(w.body)).toBe('["ok","version"]')
    expect(keys((await get('read', { path: at('f.txt') })).body)).toBe('["content","encoding","ok","version"]')
    await fs.mkdir(at('d'))
    const list = await fsApiRoute('/api/fs/list', 'GET', new URLSearchParams({ path: at('.') }), noBody)
    const entries = list?.body as Record<string, unknown>[]
    expect(entries.map((e) => keys(e)).join('|')).toBe('["dir","ignored","name"]|["dir","ignored","name"]')
    expect(JSON.stringify(entries.map((e) => e.name))).toBe('["d","f.txt"]')
    expect(keys((await get('read-binary', { path: at('f.txt') })).body)).toBe('["base64"]')
    expect(JSON.stringify((await get('exists', { path: at('f.txt') })).body)).toBe('{"exists":true}')
    expect(JSON.stringify((await post('mkdir', { path: at('d2') })).body)).toBe('{"ok":true,"created":true}')
    expect((await get('read', { path: at('missing.txt') })).status).toBe(404)
  })
})

test('list-v2 and stat give kind/size and coded failures', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.txt'), 'abc')
    await fs.symlink(at('nowhere'), at('broken'))
    const l = await get('list-v2', { path: at('.') })
    expect(l.status).toBe(200)
    const es = l.body.entries as { name: string; kind: string; size?: number }[]
    expect(JSON.stringify(es.map((e) => [e.name, e.kind]))).toBe('[["a.txt","file"],["broken","symlink-broken"]]')
    expect(es[0]?.size).toBe(3)
    expect((await get('list-v2', { path: at('nope') })).status).toBe(404)
    const st = await get('stat', { path: at('a.txt') })
    expect(st.status).toBe(200)
    expect(typeof st.body.version).toBe('string')
  })
})

test('raw via dispatcher: ?download=1 -> Content-Disposition attachment; without it, none (inline)', async () => {
  const prev = process.env.WEBTERM_FILES_VIEWERS
  process.env.WEBTERM_FILES_VIEWERS = 'on'
  try {
    await withTmp(async (at) => {
      await fs.writeFile(at('pic.png'), 'x')
      const raw = async (q: Record<string, string>) =>
        (await fsApiRoute('/api/fs/raw', 'GET', new URLSearchParams({ path: at('pic.png'), ...q }), noBody, { headers: {} }))?.raw
      const dl = await raw({ download: '1' })
      expect(dl?.headers['Content-Disposition']?.startsWith('attachment')).toBe(true)
      expect((await raw({}))?.headers['Content-Disposition']).toBe(undefined)
      expect((await raw({ download: '0' }))?.headers['Content-Disposition']).toBe(undefined)
    })
  } finally {
    if (prev === undefined) delete process.env.WEBTERM_FILES_VIEWERS
    else process.env.WEBTERM_FILES_VIEWERS = prev
  }
})
