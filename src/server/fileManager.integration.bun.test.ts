// Alur file manager berurutan lewat `fsApiRoute` (jalur yang sama dengan HTTP) terhadap filesystem
// NYATA: create -> write berversi -> konflik versi -> rename -> delete (trash) -> restore -> raw.
// Satu skenario sengaja berantai: tiap langkah memakai hasil langkah sebelumnya. Bun-only.
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { fsApiRoute } from './fsApi'
import type { RawReply } from './fsRaw'

type Out = { status: number; body: Record<string, unknown>; raw?: RawReply }
const ENV_KEYS = ['WEBTERM_DATA_DIR', 'HOME', 'WEBTERM_FILES_MUTATE', 'WEBTERM_FILES_VIEWERS'] as const

/** Root temp berisi `work/`, `data/` (WEBTERM_DATA_DIR = trash) dan `home/`; flag MUTATE+VIEWERS on; env dipulihkan. */
async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fm-int-')))
  const prev = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  await fs.mkdir(npath.join(root, 'work'))
  await fs.mkdir(npath.join(root, 'home'))
  process.env.WEBTERM_DATA_DIR = npath.join(root, 'data')
  process.env.HOME = npath.join(root, 'home')
  process.env.WEBTERM_FILES_MUTATE = 'on'
  process.env.WEBTERM_FILES_VIEWERS = 'on'
  try {
    await fn((...s) => npath.join(root, 'work', ...s))
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 2 })
  }
}

async function call(method: 'GET' | 'POST', verb: string, params: Record<string, string>, payload?: unknown): Promise<Out> {
  const r = await fsApiRoute(`/api/fs/${verb}`, method, new URLSearchParams(params), () => Promise.resolve(JSON.stringify(payload ?? {})))
  return { status: r?.status ?? -1, body: (r?.body ?? {}) as Record<string, unknown>, raw: r?.raw }
}
const get = (verb: string, params: Record<string, string>): Promise<Out> => call('GET', verb, params)
const post = (verb: string, payload: unknown): Promise<Out> => call('POST', verb, {}, payload)
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

async function bytesOf(r: RawReply): Promise<string> {
  if (!r.body) return ''
  if (Buffer.isBuffer(r.body)) return r.body.toString('utf8')
  const parts: Buffer[] = []
  for await (const c of r.body) parts.push(c as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

test('create -> versioned write -> version conflict -> rename -> trash -> restore -> raw', async () => {
  await withTmp(async (at) => {
    // 1. create: eksklusif, membawa versi; nama yang sama kedua kali = 409 EEXIST tanpa menimpa.
    const created = await post('create', { path: at('note.txt'), content: 'v1' })
    expect(created.status).toBe(200)
    const v1 = created.body.version as string
    expect(typeof v1).toBe('string')
    const dup = await post('create', { path: at('note.txt'), content: 'clobber' })
    expect(dup.status).toBe(409)
    expect(dup.body.code).toBe('EEXIST')
    expect(await fs.readFile(at('note.txt'), 'utf8')).toBe('v1')

    // 2. write berversi: versi terakhir diterima, versi baru berbeda dan sama dengan hasil read.
    const w2 = await post('write', { path: at('note.txt'), content: 'v2 é中', expectedVersion: v1, mustExist: true })
    expect(w2.status).toBe(200)
    const v2 = w2.body.version as string
    expect(v2 === v1).toBe(false)
    const read = await get('read', { path: at('note.txt') })
    expect(read.body.version).toBe(v2)
    expect(read.body.content).toBe('v2 é中')

    // 3. konflik: menulis dengan versi basi ditolak 409 EVERSION, melaporkan versi sekarang, file utuh.
    const stale = await post('write', { path: at('note.txt'), content: 'lost update', expectedVersion: v1, mustExist: true })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('EVERSION')
    expect(stale.body.current).toBe(v2)
    expect(await fs.readFile(at('note.txt'), 'utf8')).toBe('v2 é中')

    // 4. rename: sumber hilang, tujuan berisi data yang sama; tujuan yang sudah ada tidak ditimpa.
    await fs.writeFile(at('taken.txt'), 'other')
    const clash = await post('rename', { from: at('note.txt'), to: at('taken.txt') })
    expect(clash.status).toBe(409)
    expect(await fs.readFile(at('taken.txt'), 'utf8')).toBe('other')
    const renamed = await post('rename', { from: at('note.txt'), to: at('renamed.txt') })
    expect(renamed.status).toBe(200)
    expect(await exists(at('note.txt'))).toBe(false)
    expect(await fs.readFile(at('renamed.txt'), 'utf8')).toBe('v2 é中')

    // 5. delete default = trash: file hilang dari tempatnya, ada di <data>/trash/<id>.
    const del = await post('delete', { path: at('renamed.txt') })
    expect(del.status).toBe(200)
    const trashId = del.body.trashId as string
    expect(typeof trashId).toBe('string')
    expect(await exists(at('renamed.txt'))).toBe(false)
    expect(await exists(npath.join(process.env.WEBTERM_DATA_DIR as string, 'trash', trashId))).toBe(true)

    // 6. restore: kembali ke path asal dengan isi utuh; entri trash habis.
    const back = await post('restore', { trashId })
    expect(back.status).toBe(200)
    expect(back.body.path).toBe(at('renamed.txt'))
    expect(await fs.readFile(at('renamed.txt'), 'utf8')).toBe('v2 é中')
    expect(await exists(npath.join(process.env.WEBTERM_DATA_DIR as string, 'trash', trashId))).toBe(false)

    // 7. raw: bytes yang sama, ETag = versi file, Range menghasilkan 206 dengan potongan yang benar.
    const full = await get('raw', { path: at('renamed.txt') })
    expect(full.status).toBe(200)
    expect(await bytesOf(full.raw as RawReply)).toBe('v2 é中')
    const stat = await get('read', { path: at('renamed.txt') })
    expect((full.raw as RawReply).headers.ETag).toContain(String(stat.body.version))
    const part = await fs.writeFile(at('digits.txt'), '0123456789').then(() => fsApiRoute('/api/fs/raw', 'GET', new URLSearchParams({ path: at('digits.txt') }), () => Promise.resolve(''), { headers: { range: 'bytes=2-4' } }))
    expect(part?.status).toBe(206)
    expect(await bytesOf(part?.raw as RawReply)).toBe('234')
  })
})

test('mutation and raw verbs answer 501 EDISABLED when their flags are off', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.txt'), 'x')
    delete process.env.WEBTERM_FILES_MUTATE
    delete process.env.WEBTERM_FILES_VIEWERS
    const del = await post('delete', { path: at('a.txt') })
    expect(del.status).toBe(501)
    expect(del.body.code).toBe('EDISABLED')
    expect(await exists(at('a.txt'))).toBe(true)
    const raw = await get('raw', { path: at('a.txt') })
    expect(raw.status).toBe(501)
    expect(raw.body.code).toBe('EDISABLED')
  })
})
