import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FS_ERR_STATUS } from '../shared/fsContract'
import { FILES_FLAG } from './envRegistry.files'
import { fsApiRoute } from './fsApi'

const noBody = () => Promise.resolve('')
const json = (v: unknown) => () => Promise.resolve(JSON.stringify(v))
const q = (o: Record<string, string> = {}) => new URLSearchParams(o)
const GATED: [string, string, Record<string, string>][] = [
  ['delete', 'POST', {}], ['restore', 'POST', {}], ['rename', 'POST', {}], ['copy', 'POST', {}],
  ['raw', 'GET', { path: '/x' }], ['git-status', 'GET', { path: '/x' }], ['search', 'GET', { root: '/x', q: 'a' }], ['upload', 'POST', { dir: '/x', name: 'a' }],
]

afterEach(() => { for (const k of [...Object.values(FILES_FLAG), 'WEBTERM_FILES_LIST_MAX']) delete process.env[k] })

describe('fsApi dispatcher', () => {
  let dir = ''
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'wt-fsdispatch-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('flag mati -> 501 EDISABLED SEBELUM body dibaca, untuk setiap verb berflag', async () => {
    for (const [verb, method, params] of GATED) {
      const body = vi.fn(noBody)
      const res = await fsApiRoute(`/api/fs/${verb}`, method, q(params), body)
      expect(res?.status, verb).toBe(501)
      expect(res?.body, verb).toMatchObject({ ok: false, code: 'EDISABLED' })
      expect(body, verb).not.toHaveBeenCalled()
    }
  })

  it('flag on -> handler dipanggil (git-status stub: marks kosong, 200)', async () => {
    process.env[FILES_FLAG.GIT_STATUS] = 'on'
    const res = await fsApiRoute('/api/fs/git-status', 'GET', q({ path: dir }), noBody)
    expect(res).toEqual({ status: 200, body: { ok: true, marks: {} } })
  })

  it('path kosong/hilang -> 400 EINVAL (GET via query, POST via body)', async () => {
    for (const p of [{}, { path: '' }, { path: '   ' }] as Record<string, string>[]) {
      const res = await fsApiRoute('/api/fs/list', 'GET', q(p), noBody)
      expect(res?.status).toBe(400)
      expect(res?.body).toMatchObject({ ok: false, code: 'EINVAL', error: 'path required' })
    }
    expect((await fsApiRoute('/api/fs/write', 'POST', q(), json({ path: '', content: 'x' })))?.status).toBe(400)
    expect((await fsApiRoute('/api/fs/mkdir', 'POST', q(), json({})))?.status).toBe(400)
  })

  it('body bukan JSON / content bukan string -> 400, tanpa menulis apa pun', async () => {
    expect((await fsApiRoute('/api/fs/write', 'POST', q(), () => Promise.resolve('{nope')))?.body).toMatchObject({ code: 'EINVAL', error: 'bad json' })
    const f = join(dir, 'untouched.txt')
    const res = await fsApiRoute('/api/fs/write', 'POST', q(), json({ path: f, content: { a: 1 } }))
    expect(res?.status).toBe(400)
    await expect(readFile(f)).rejects.toThrow()
  })

  it('verb tak dikenal, metode salah, dan path lain', async () => {
    expect((await fsApiRoute('/api/fs/bogus', 'GET', q(), noBody))?.status).toBe(404)
    expect((await fsApiRoute('/api/fs/toString', 'GET', q(), noBody))?.status).toBe(404) // bukan warisan prototype
    expect((await fsApiRoute('/api/fs/list', 'POST', q({ path: dir }), noBody))?.status).toBe(404)
    expect(await fsApiRoute('/api/fs', 'GET', q(), noBody)).toBeNull()
    expect(await fsApiRoute('/api/other/list', 'GET', q(), noBody)).toBeNull()
  })

  it('capabilities mencerminkan env (default semua off, listMax 5000)', async () => {
    const off = await fsApiRoute('/api/fs/capabilities', 'GET', q(), noBody)
    expect(off).toEqual({ status: 200, body: { ok: true, mutate: false, viewers: false, watch: false, git: false, quickOpen: false, upload: false, listMax: 5000 } })
    process.env[FILES_FLAG.MUTATE] = 'on'
    process.env[FILES_FLAG.UPLOAD] = 'on'
    process.env.WEBTERM_FILES_LIST_MAX = '100'
    expect((await fsApiRoute('/api/fs/capabilities', 'GET', q(), noBody))?.body).toMatchObject({ mutate: true, upload: true, git: false, listMax: 100 })
  })

  it('FsFail dipetakan ke status: create ke file ada -> 409 EEXIST dan isi lama utuh', async () => {
    const f = join(dir, 'exists.txt')
    await writeFile(f, 'ORIGINAL')
    const res = await fsApiRoute('/api/fs/create', 'POST', q(), json({ path: f, content: 'NEW' }))
    expect(res?.status).toBe(FS_ERR_STATUS.EEXIST)
    expect(res?.body).toMatchObject({ ok: false, code: 'EEXIST' })
    expect(await readFile(f, 'utf8')).toBe('ORIGINAL')
    const fresh = join(dir, 'fresh.txt')
    expect((await fsApiRoute('/api/fs/create', 'POST', q(), json({ path: fresh })))?.status).toBe(200)
    expect(await readFile(fresh, 'utf8')).toBe('')
  })

  it('verb lama tetap bentuk lama + field aditif', async () => {
    const f = join(dir, 'legacy.txt')
    expect(await fsApiRoute('/api/fs/write', 'POST', q(), json({ path: f, content: 'héllo €' }))).toEqual({ status: 200, body: { ok: true, version: expect.stringMatching(/^\d+-10$/) } })
    expect((await fsApiRoute('/api/fs/read', 'GET', q({ path: f }), noBody))?.body).toMatchObject({ content: 'héllo €', version: expect.stringMatching(/^\d+-10$/), encoding: 'utf8' })
    const listed = await fsApiRoute('/api/fs/list', 'GET', q({ path: dir }), noBody)
    expect(Array.isArray(listed?.body)).toBe(true)
    expect((await fsApiRoute('/api/fs/exists', 'GET', q({ path: f }), noBody))?.body).toEqual({ exists: true })
    expect((await fsApiRoute('/api/fs/mkdir', 'POST', q(), json({ path: join(dir, 'sub') })))?.body).toEqual({ ok: true, created: true })
    expect((await fsApiRoute('/api/fs/mkdir', 'POST', q(), json({ path: join(dir, 'sub') })))?.body).toEqual({ ok: true, created: false })
    expect((await fsApiRoute('/api/fs/stat', 'GET', q({ path: f }), noBody))?.body).toMatchObject({ ok: true, meta: { name: 'legacy.txt', dir: false } })
    expect((await fsApiRoute('/api/fs/stat', 'GET', q({ path: join(dir, 'nope') }), noBody))?.status).toBe(404)
  })

  it('list-v2 dipotong di LIST_MAX dan menandai truncated', async () => {
    const d = join(dir, 'many')
    await fsApiRoute('/api/fs/mkdir', 'POST', q(), json({ path: d }))
    for (const n of ['a', 'b', 'c']) await writeFile(join(d, n), n)
    process.env.WEBTERM_FILES_LIST_MAX = '100'
    expect((await fsApiRoute('/api/fs/list-v2', 'GET', q({ path: d }), noBody))?.body).toMatchObject({ ok: true, truncated: false })
    const cut = await fsApiRoute('/api/fs/list-v2', 'GET', q({ path: d, limit: '2' }), noBody)
    expect(cut?.body).toMatchObject({ ok: true, truncated: true })
    expect(((cut?.body as { entries: unknown[] }).entries).length).toBe(2)
  })
})
