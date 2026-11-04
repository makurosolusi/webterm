import { test, expect, afterEach, vi } from 'vitest'
import { list, read, readBinary, resetCapabilitiesCache } from './fsClient'
const ws = vi.hoisted(() => ({ cbs: [] as Array<() => void> }))
vi.mock('./ws', () => ({ onReconnect: (cb: () => void) => { ws.cbs.push(cb); return () => {} } }))
import { tooLargeSentinel } from '../shared/fsLimits'

/**
 * Yang dijaga file ini adalah DUA kontrak error `./fsClient`, dan terutama bedanya:
 * `read`/`readBinary` melempar saat gagal, sementara `list` tetap fail-open karena
 * `classifyEmptyListing` bergantung padanya. Assertion `list` di bawah ada supaya perbaikan
 * kejujuran pada pembacaan isi tidak diam-diam ikut merusak penelusuran.
 */

const realFetch = globalThis.fetch

/** Stub `globalThis.fetch` dengan satu respons; pola stub global yang sama dengan `./ws.test.ts`. */
function stubFetch(init: { ok?: boolean; status?: number; body?: unknown; reject?: string }): void {
  globalThis.fetch = (() =>
    init.reject !== undefined
      ? Promise.reject(new Error(init.reject))
      : Promise.resolve({
          ok: init.ok ?? true,
          status: init.status ?? 200,
          statusText: '',
          json: () =>
            init.body === undefined
              ? Promise.reject(new Error('Unexpected end of JSON input'))
              : Promise.resolve(init.body),
        })) as typeof globalThis.fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  resetCapabilitiesCache()
})

test('read throws on a failing HTTP response, with operation + path in the message', async () => {
  stubFetch({ ok: false, status: 403 })
  await expect(read('/secret/notes.txt')).rejects.toThrow(/fs read "\/secret\/notes\.txt".*403/)
})

test('read throws when the network itself fails', async () => {
  stubFetch({ reject: 'Failed to fetch' })
  await expect(read('/a.txt')).rejects.toThrow(/fs read "\/a\.txt": Failed to fetch/)
})

test('read throws on a malformed JSON body instead of answering empty', async () => {
  stubFetch({ ok: true }) // body undefined → res.json() rejects
  await expect(read('/a.txt')).rejects.toThrow(/fs read "\/a\.txt"/)
})

test('read throws when the response has no content field', async () => {
  stubFetch({ body: {} })
  await expect(read('/a.txt')).rejects.toThrow(/response has no content field/)
})

test('read returns the file contents on success', async () => {
  stubFetch({ body: { content: 'hello\nworld\n' } })
  await expect(read('/a.txt')).resolves.toBe('hello\nworld\n')
})

// INTI dari perubahan ini: dulu '' bisa berarti "kosong" ATAU "gagal", dan node editor tidak bisa
// membedakannya — buffer kosong yang bisa disimpan menimpa file asli. Sekarang gagal = reject,
// jadi '' hanya punya satu arti.
test('a genuinely empty file resolves to "" and does NOT throw', async () => {
  stubFetch({ body: { content: '' } })
  await expect(read('/empty.txt')).resolves.toBe('')
})

test('the too-large sentinel passes through as a success, not a failure', async () => {
  const sentinel = tooLargeSentinel(99_000_000)
  stubFetch({ body: { content: sentinel } })
  await expect(read('/huge.log')).resolves.toBe(sentinel)
})

test('readBinary throws on failure but passes an empty payload through', async () => {
  stubFetch({ ok: false, status: 500 })
  await expect(readBinary('/img.png')).rejects.toThrow(/fs read-binary "\/img\.png".*500/)
  stubFetch({ body: { base64: 'AAAA' } })
  await expect(readBinary('/img.png')).resolves.toBe('AAAA')
})

// Kontrak penelusuran, DIJAGA: `classifyEmptyListing` membedakan "direktori kosong" dari "tidak ada
// di sana" dengan bertanya ke direktori induk, justru karena `list` tidak pernah melempar.
test('list stays fail-open: a failing response yields [] and never rejects', async () => {
  stubFetch({ ok: false, status: 404 })
  await expect(list('/nope')).resolves.toEqual([])
  stubFetch({ reject: 'Failed to fetch' })
  await expect(list('/nope')).resolves.toEqual([])
})

test('list returns entries on success', async () => {
  stubFetch({ body: [{ name: 'a.txt', isDir: false }] })
  await expect(list('/dir')).resolves.toHaveLength(1)
})

// ---- Kontrak 3: verb baru ber-`FsResult` (tak pernah melempar, FsFail di-parse walau non-2xx) ----
import { capabilities, create, rawUrl, writeChecked, readMeta, exists, write } from './fsClient'

test('writeChecked: 409 EVERSION ter-parse sebagai FsFail lengkap dengan current', async () => {
  stubFetch({ ok: false, status: 409, body: { ok: false, code: 'EVERSION', error: 'changed', current: '9-9' } })
  expect(await writeChecked('/a.txt', 'x', { expectedVersion: '1-1' })).toEqual({ ok: false, code: 'EVERSION', error: 'changed', current: '9-9' })
})

test('create: 409 EEXIST ter-parse; sukses membawa version', async () => {
  stubFetch({ ok: false, status: 409, body: { ok: false, code: 'EEXIST', error: 'already exists' } })
  expect(await create('/a.txt')).toMatchObject({ ok: false, code: 'EEXIST' })
  stubFetch({ body: { ok: true, version: '1-2' } })
  expect(await create('/b.txt')).toEqual({ ok: true, version: '1-2' })
})

test('FsResult tidak melempar: jaringan mati / body bukan FsFail jadi EIO', async () => {
  stubFetch({ reject: 'Failed to fetch' })
  expect(await create('/a.txt')).toMatchObject({ ok: false, code: 'EIO' })
  stubFetch({ ok: false, status: 502 })
  expect(await create('/a.txt')).toMatchObject({ ok: false, code: 'EIO', error: expect.stringContaining('502') })
})

test('kontrak lama tetap: write boolean (409 -> false), exists fail-open, read tetap melempar', async () => {
  stubFetch({ ok: false, status: 500, body: { ok: false, code: 'EIO', error: 'x' } })
  expect(await write('/a.txt', 'x')).toBe(false)
  stubFetch({ reject: 'down' })
  expect(await exists('/a.txt')).toBe(false)
  await expect(read('/a.txt')).rejects.toThrow(/fs read/)
})

test('readMeta membawa version/encoding; default utf8 + version kosong untuk server lama', async () => {
  stubFetch({ body: { content: 'hi', version: '3-2', encoding: 'non-utf8' } })
  expect(await readMeta('/a.txt')).toEqual({ content: 'hi', version: '3-2', encoding: 'non-utf8' })
  stubFetch({ body: { content: 'hi' } })
  expect(await readMeta('/a.txt')).toEqual({ content: 'hi', version: '', encoding: 'utf8' })
})

test('capabilities fail-closed saat gagal; mencerminkan server saat sukses', async () => {
  stubFetch({ reject: 'down' })
  expect(await capabilities()).toMatchObject({ mutate: false, upload: false, listMax: 0 })
  stubFetch({ body: { ok: true, mutate: true, viewers: false, watch: false, git: false, quickOpen: false, upload: true, listMax: 5000 } })
  expect(await capabilities()).toMatchObject({ mutate: true, upload: true, listMax: 5000 })
})

test('rawUrl memakai verb raw dan meng-encode path', () => {
  expect(rawUrl('/a b/c.png')).toMatch(/^\/api\/fs\/raw\?path=%2Fa\+b%2Fc\.png/)
})

// ---- cache capabilities() ----
const CAPS_BODY = { ok: true, mutate: true, viewers: true, watch: true, git: true, quickOpen: true, upload: true, listMax: 5000 }

/** Stub fetch yang menghitung panggilan; `replies` dipakai berurutan (terakhir diulang). */
function countingFetch(...replies: Array<{ body?: unknown; reject?: string }>): { calls: () => number } {
  let n = 0
  globalThis.fetch = (() => {
    const r = replies[Math.min(n++, replies.length - 1)]
    return r.reject !== undefined
      ? Promise.reject(new Error(r.reject))
      : Promise.resolve({ ok: true, status: 200, statusText: '', json: () => Promise.resolve(r.body) })
  }) as typeof globalThis.fetch
  return { calls: () => n }
}

test('capabilities: panggilan serentak berbagi satu fetch dan satu objek', async () => {
  const f = countingFetch({ body: CAPS_BODY })
  const [a, b] = await Promise.all([capabilities(), capabilities()])
  expect(f.calls()).toBe(1)
  expect(a).toBe(b)
})

test('capabilities: panggilan setelah sukses tidak fetch lagi', async () => {
  const f = countingFetch({ body: CAPS_BODY })
  await capabilities()
  expect(await capabilities()).toMatchObject({ mutate: true, listMax: 5000 })
  expect(f.calls()).toBe(1)
})

test('capabilities: kegagalan tidak di-cache; fetch ulang dan pulih', async () => {
  const f = countingFetch({ reject: 'down' }, { body: CAPS_BODY })
  expect(await capabilities()).toMatchObject({ mutate: false, listMax: 0 })
  expect(await capabilities()).toMatchObject({ mutate: true, listMax: 5000 })
  expect(f.calls()).toBe(2)
})

test('capabilities: resetCapabilitiesCache dan onReconnect memaksa fetch ulang', async () => {
  const f = countingFetch({ body: CAPS_BODY })
  await capabilities()
  resetCapabilitiesCache()
  await capabilities()
  expect(f.calls()).toBe(2)
  expect(ws.cbs.length).toBeGreaterThan(0)
  ws.cbs.forEach((cb) => cb())
  await capabilities()
  expect(f.calls()).toBe(3)
})
