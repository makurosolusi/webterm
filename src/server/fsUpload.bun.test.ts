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

test('overwrite replaces an existing file atomically; no tmp left', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(npath.join(dir, 'a.txt'), 'ORIGINAL')
    const r = await uploadFile(dir, 'a.txt', body('NEW'), MAX, true)
    expect(code(r)).toBe('ok')
    expect(await fs.readFile(npath.join(dir, 'a.txt'), 'utf8')).toBe('NEW')
    expect((await fs.readdir(dir)).join(',')).toBe('a.txt')
  })
})

test('overwrite with no existing file just creates it', async () => {
  await withDir(async (dir) => {
    expect(code(await uploadFile(dir, 'new.txt', body('x'), MAX, true))).toBe('ok')
    expect(await fs.readFile(npath.join(dir, 'new.txt'), 'utf8')).toBe('x')
  })
})

test('overwrite onto a directory or a symlink to one: EISDIR, both untouched, no tmp', async () => {
  await withDir(async (dir) => {
    await fs.mkdir(npath.join(dir, 'sub'))
    await fs.writeFile(npath.join(dir, 'sub', 'keep'), 'K')
    await fs.symlink(npath.join(dir, 'sub'), npath.join(dir, 'link'))
    expect(code(await uploadFile(dir, 'sub', body('x'), MAX, true))).toBe('EISDIR')
    expect(code(await uploadFile(dir, 'link', body('x'), MAX, true))).toBe('EISDIR')
    expect((await fs.lstat(npath.join(dir, 'link'))).isSymbolicLink()).toBe(true)
    expect((await fs.readdir(npath.join(dir, 'sub'))).join(',')).toBe('keep')
    expect((await fs.readdir(dir)).sort().join(',')).toBe('link,sub')
  })
})

test('overwrite onto a symlink to a file outside replaces the link, never the outside target', async () => {
  await withDir(async (outside) => {
    await withDir(async (dir) => {
      const target = npath.join(outside, 'secret')
      await fs.writeFile(target, 'OUTSIDE')
      await fs.symlink(target, npath.join(dir, 'ln'))
      expect(code(await uploadFile(dir, 'ln', body('NEW'), MAX, true))).toBe('ok')
      expect(await fs.readFile(target, 'utf8')).toBe('OUTSIDE')
      expect((await fs.lstat(npath.join(dir, 'ln'))).isFile()).toBe(true)
      expect(await fs.readFile(npath.join(dir, 'ln'), 'utf8')).toBe('NEW')
    })
  })
})

test('capped or aborted overwrite: original untouched, tmp removed', async () => {
  await withDir(async (dir) => {
    await fs.writeFile(npath.join(dir, 'a.txt'), 'ORIGINAL')
    expect(code(await uploadFile(dir, 'a.txt', body('a'.repeat(MAX + 1)), MAX, true))).toBe('ETOOLARGE')
    const s = new PassThrough()
    const p = uploadFile(dir, 'a.txt', s, MAX, true)
    s.write('partial')
    await new Promise((r) => setTimeout(r, 30))
    s.destroy(new Error('client went away'))
    expect(code(await p)).toBe('EIO')
    expect(await fs.readFile(npath.join(dir, 'a.txt'), 'utf8')).toBe('ORIGINAL')
    expect((await fs.readdir(dir)).join(',')).toBe('a.txt')
  })
})

test('overwrite keeps the replaced file permission bits (executable stays executable)', async () => {
  await withDir(async (dir) => {
    const f = npath.join(dir, 'run.sh')
    await fs.writeFile(f, 'OLD')
    await fs.chmod(f, 0o755)
    expect(code(await uploadFile(dir, 'run.sh', body('#!/bin/sh'), MAX, true))).toBe('ok')
    expect(((await fs.stat(f)).mode & 0o7777).toString(8)).toBe('755')
    expect(await fs.readFile(f, 'utf8')).toBe('#!/bin/sh')
  })
})

test('overwrite where the target cannot be inspected: error reported, nothing written', async () => {
  await withDir(async (dir) => {
    await fs.symlink('loop', npath.join(dir, 'loop')) // stat through a self-loop fails with ELOOP, not ENOENT
    expect(code(await uploadFile(dir, 'loop', body('x'), MAX, true))).toBe('EIO')
    expect((await fs.lstat(npath.join(dir, 'loop'))).isSymbolicLink()).toBe(true)
    expect((await fs.readdir(dir)).join(',')).toBe('loop')
  })
})
