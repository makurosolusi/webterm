// `uploadFile` terhadap filesystem NYATA (WS-FM-10). Bun-only; matcher terbatas toBe/toContain.
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { FsResult } from '../shared/fsContract'
import { uploadFile } from './fsUpload'

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-up-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
const code = (r: FsResult<object>): string => (r.ok ? 'ok' : r.code)
const body = (...parts: string[]): Readable => Readable.from(parts.map((p) => Buffer.from(p)))
const MAX = 1024

test('streams chunks to tmp then publishes under the name; no tmp left', async () => {
  await withDir(async (dir) => {
    const r = await uploadFile(dir, 'hello.txt', body('hel', 'lo ', 'world'), MAX)
    expect(code(r)).toBe('ok')
    expect(r.ok && (r.version ?? '').length > 0).toBe(true)
    expect(await fs.readFile(npath.join(dir, 'hello.txt'), 'utf8')).toBe('hello world')
    expect((await fs.readdir(dir)).join(',')).toBe('hello.txt')
  })
})

test('empty body creates an empty file', async () => {
  await withDir(async (dir) => {
    expect(code(await uploadFile(dir, 'empty', body(), MAX))).toBe('ok')
    expect((await fs.stat(npath.join(dir, 'empty'))).size).toBe(0)
  })
})

test('dangerous names are rejected and nothing is written', async () => {
  await withDir(async (dir) => {
    const cases: Array<[string, string]> = [
      ['', 'EINVAL'], ['.', 'EINVAL'], ['..', 'EINVAL'], ['a/b', 'EINVAL'], ['../x', 'EINVAL'],
      ['a\\b', 'EINVAL'], ['a\0b', 'EINVAL'], ['x'.repeat(256), 'ENAMETOOLONG'], ['é'.repeat(128), 'ENAMETOOLONG'],
    ]
    for (const [name, want] of cases) expect(`${JSON.stringify(name)}:${code(await uploadFile(dir, name, body('x'), MAX))}`).toBe(`${JSON.stringify(name)}:${want}`)
    expect((await fs.readdir(dir)).length).toBe(0)
    expect((await fs.readdir(npath.dirname(dir))).includes('x')).toBe(false)
  })
})

test('a name containing ".." inside a segment is legitimate', async () => {
  await withDir(async (dir) => {
    expect(code(await uploadFile(dir, 'v1..2.txt', body('x'), MAX))).toBe('ok')
  })
})

test('over the cap: ETOOLARGE, tmp removed, no file', async () => {
  await withDir(async (dir) => {
    const r = await uploadFile(dir, 'big.bin', body('a'.repeat(600), 'b'.repeat(600)), MAX)
    expect(code(r)).toBe('ETOOLARGE')
    expect((await fs.readdir(dir)).length).toBe(0)
  })
})

test('exactly at the cap is accepted', async () => {
  await withDir(async (dir) => {
    expect(code(await uploadFile(dir, 'edge', body('a'.repeat(MAX)), MAX))).toBe('ok')
    expect((await fs.stat(npath.join(dir, 'edge'))).size).toBe(MAX)
  })
})

test('existing name: EEXIST, original untouched, tmp removed', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(npath.join(dir, 'a.txt'), 'ORIGINAL')
    expect(code(await uploadFile(dir, 'a.txt', body('NEW'), MAX))).toBe('EEXIST')
    expect(await fs.readFile(npath.join(dir, 'a.txt'), 'utf8')).toBe('ORIGINAL')
    expect((await fs.readdir(dir)).join(',')).toBe('a.txt')
  })
})

test('aborted stream (destroyed mid-body): failure and tmp removed', async () => {
  await withDir(async (dir) => {
    const s = new PassThrough()
    const p = uploadFile(dir, 'cut.bin', s, MAX)
    s.write('partial')
    await new Promise((r) => setTimeout(r, 30))
    s.destroy(new Error('client went away'))
    expect(code(await p)).toBe('EIO')
    expect((await fs.readdir(dir)).length).toBe(0)
  })
})

test('missing directory, file as directory, missing body, relative dir', async () => {
  await withDir(async (dir) => {
    expect(code(await uploadFile(npath.join(dir, 'nope'), 'a', body('x'), MAX))).toBe('ENOENT')
    await fs.writeFile(npath.join(dir, 'f'), '')
    expect(code(await uploadFile(npath.join(dir, 'f'), 'a', body('x'), MAX))).toBe('ENOTDIR')
    expect(code(await uploadFile(dir, 'a', undefined, MAX))).toBe('EINVAL')
    expect(code(await uploadFile('rel/dir', 'a', body('x'), MAX))).toBe('EINVAL')
    expect((await fs.readdir(dir)).join(',')).toBe('f')
  })
})
