// Verb mutasi (`fsOps.mutate.ts`) terhadap filesystem NYATA di $TMPDIR: errno asli, symlink, mode.
// Bun-only; matcher terbatas pada yang diekspos `bun-test.d.ts` (toBe/toContain). Test izin dilewati
// bila dijalankan sebagai root (root mengabaikan bit mode).
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import type { FsResult } from '../shared/fsContract'
import { copyEntry, deleteEntry, movePath, renameEntry, restoreEntry } from './fsOps.mutate'
import { lookupTrash, trashRoot } from './fsTrash'

type At = (...s: string[]) => string
const isRoot = process.getuid?.() === 0

/** Root temp berisi `work/` (fixture), `data/` (WEBTERM_DATA_DIR) dan `home/` (HOME). Env dipulihkan. */
async function withTmp(fn: (at: At) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fsmut-'))
  const prev = { data: process.env.WEBTERM_DATA_DIR, home: process.env.HOME }
  await fs.mkdir(npath.join(root, 'work'), { recursive: true })
  await fs.mkdir(npath.join(root, 'home'))
  process.env.WEBTERM_DATA_DIR = npath.join(root, 'data')
  process.env.HOME = npath.join(root, 'home')
  try {
    await fn((...s) => npath.join(root, 'work', ...s))
  } finally {
    for (const [k, v] of [['WEBTERM_DATA_DIR', prev.data], ['HOME', prev.home]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 2 })
  }
}

const codeOf = (r: FsResult<object>): string => (r.ok ? 'ok' : r.code)
const trashIdOf = (r: FsResult<{ trashId?: string }>): string => (r.ok ? (r.trashId ?? '') : 'FAIL')
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')
const trashEntries = (): Promise<string[]> => fs.readdir(trashRoot()).catch(() => [])

// ---- delete / restore ----

test('delete moves to <data>/trash/<id>/<name> with meta, restore brings it back intact', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d', 'sub'), { recursive: true })
    await fs.writeFile(at('d', 'sub', 'f.txt'), 'hello')
    const r = await deleteEntry(at('d'), {})
    const id = trashIdOf(r)
    expect(codeOf(r)).toBe('ok')
    expect(await exists(at('d'))).toBe(false)
    expect(await read(npath.join(trashRoot(), id, 'd', 'sub', 'f.txt'))).toBe('hello')
    const meta = JSON.parse(await read(npath.join(trashRoot(), id, 'meta.json'))) as { origPath: string; deletedAt: number }
    expect(meta.origPath).toBe(at('d'))
    const back = await restoreEntry(id)
    expect(back.ok ? back.path : 'FAIL').toBe(at('d'))
    expect(await read(at('d', 'sub', 'f.txt'))).toBe('hello')
    expect(await exists(npath.join(trashRoot(), id))).toBe(false)
  })
})

test('restore onto an existing name is EEXIST: nothing overwritten, trash entry kept', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.txt'), 'old')
    const id = trashIdOf(await deleteEntry(at('a.txt'), {}))
    await fs.writeFile(at('a.txt'), 'NEW')
    expect(codeOf(await restoreEntry(id))).toBe('EEXIST')
    expect(await read(at('a.txt'))).toBe('NEW')
    expect(await read(npath.join(trashRoot(), id, 'a.txt'))).toBe('old')
  })
})

test('restore: parent folder gone is ENOENT; traversal/unknown ids are refused without touching disk', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('p'))
    await fs.writeFile(at('p', 'a.txt'), 'x')
    const id = trashIdOf(await deleteEntry(at('p', 'a.txt'), {}))
    await fs.rmdir(at('p'))
    expect(codeOf(await restoreEntry(id))).toBe('ENOENT')
    expect(await exists(npath.join(trashRoot(), id, 'a.txt'))).toBe(true)
    expect(codeOf(await restoreEntry('../../work'))).toBe('EINVAL')
    expect(codeOf(await restoreEntry(''))).toBe('EINVAL')
    expect(codeOf(await restoreEntry('0123456789abcdef'))).toBe('ENOENT')
  })
})

test('permanent delete removes a folder recursively and never creates a trash entry', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d', 'x'), { recursive: true })
    await fs.writeFile(at('d', 'x', 'f'), '1')
    await fs.writeFile(at('keep.txt'), 'keep')
    expect(codeOf(await deleteEntry(at('d'), { permanent: true }))).toBe('ok')
    expect(await exists(at('d'))).toBe(false)
    expect((await trashEntries()).length).toBe(0)
    expect(await read(at('keep.txt'))).toBe('keep')
    expect(codeOf(await deleteEntry(at('d'), { permanent: true }))).toBe('ENOENT')
    expect(codeOf(await deleteEntry(at('nope'), {}))).toBe('ENOENT')
    expect((await trashEntries()).length).toBe(0)
  })
})

test('delete of a symlink removes the link only, never its target', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('real'))
    await fs.writeFile(at('real', 'f'), 'data')
    await fs.symlink(at('real'), at('link'))
    expect(codeOf(await deleteEntry(at('link'), { permanent: true }))).toBe('ok')
    expect(await exists(at('link'))).toBe(false)
    expect(await read(at('real', 'f'))).toBe('data')
    await fs.symlink(at('real'), at('link2'))
    const id = trashIdOf(await deleteEntry(at('link2'), {}))
    expect((await fs.lstat(npath.join(trashRoot(), id, 'link2'))).isSymbolicLink()).toBe(true)
    expect(await read(at('real', 'f'))).toBe('data')
  })
})

test('delete inside a read-only folder is EACCES and leaves no trash slot behind', async () => {
  if (isRoot) return
  await withTmp(async (at) => {
    await fs.mkdir(at('ro'))
    await fs.writeFile(at('ro', 'f'), 'x')
    await fs.chmod(at('ro'), 0o555)
    try {
      expect(codeOf(await deleteEntry(at('ro', 'f'), {}))).toBe('EACCES')
      expect(codeOf(await deleteEntry(at('ro', 'f'), { permanent: true }))).toBe('EACCES')
      expect(await read(at('ro', 'f'))).toBe('x')
      expect((await trashEntries()).length).toBe(0)
    } finally {
      await fs.chmod(at('ro'), 0o755)
    }
  })
})

test('movePath: EXDEV falls back to copy + remove (tree intact, source gone); other errors propagate', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('src', 'sub'), { recursive: true })
    await fs.writeFile(at('src', 'sub', 'f'), 'deep')
    await fs.symlink('f', at('src', 'sub', 'l'))
    const exdev = (): Promise<void> => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    await movePath(at('src'), at('dst'), exdev)
    expect(await read(at('dst', 'sub', 'f'))).toBe('deep')
    expect(await fs.readlink(at('dst', 'sub', 'l'))).toBe('f')
    expect(await exists(at('src'))).toBe(false)
    await fs.writeFile(at('one'), '1')
    let thrown = ''
    await movePath(at('one'), at('two'), () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))).catch((e: NodeJS.ErrnoException) => { thrown = e.code ?? '' })
    expect(thrown).toBe('EACCES')
    expect(await read(at('one'))).toBe('1')
  })
})

test('movePath EXDEV onto an existing target fails EEXIST and leaves source and target untouched', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('s'), 'S')
    await fs.writeFile(at('t'), 'T')
    let thrown = ''
    await movePath(at('s'), at('t'), () => Promise.reject(Object.assign(new Error('x'), { code: 'EXDEV' }))).catch((e: NodeJS.ErrnoException) => { thrown = e.code ?? '' })
    expect(thrown).toBe('EEXIST')
    expect(await read(at('s'))).toBe('S')
    expect(await read(at('t'))).toBe('T')
  })
})

// ---- penjagaan path ----

test('protected paths (/, system dirs, home and its ancestors, data dir, trash root) are refused for every verb', async () => {
  await withTmp(async (at) => {
    const home = process.env.HOME ?? ''
    await fs.mkdir(trashRoot(), { recursive: true })
    const targets = ['/', '/etc', '/usr', home, npath.dirname(home), process.env.WEBTERM_DATA_DIR ?? '', trashRoot()]
    for (const t of targets) {
      expect(codeOf(await deleteEntry(t, { permanent: true }))).toBe('EACCES')
      expect(codeOf(await deleteEntry(t, {}))).toBe('EACCES')
      expect(codeOf(await renameEntry(t, at('moved'), {}))).toBe('EACCES')
      expect(codeOf(await copyEntry(t, at('copied')))).toBe('EACCES')
    }
    await fs.writeFile(at('f'), '1')
    expect(codeOf(await renameEntry(at('f'), home, { overwrite: true }))).toBe('EACCES')
    expect(await exists(home)).toBe(true)
    expect(await exists(trashRoot())).toBe(true)
    expect(await exists(at('moved'))).toBe(false)
    expect(await exists(at('copied'))).toBe(false)
  })
})

test('invalid paths: empty, relative, NUL, over-long name are refused by every verb', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('f'), '1')
    const bad: [string, string][] = [['', 'EINVAL'], ['rel/path', 'EINVAL'], ['../x', 'EINVAL'], [at('a\0b'), 'EINVAL'], [at('n'.repeat(300)), 'ENAMETOOLONG']]
    for (const [p, code] of bad) {
      expect(codeOf(await deleteEntry(p, { permanent: true }))).toBe(code)
      expect(codeOf(await renameEntry(p, at('x'), {}))).toBe(code)
      expect(codeOf(await renameEntry(at('f'), p, {}))).toBe(code)
      expect(codeOf(await copyEntry(p, at('x')))).toBe(code)
      expect(codeOf(await copyEntry(at('f'), p))).toBe(code)
    }
    expect(await read(at('f'))).toBe('1')
  })
})

test('dot-dot segments are normalised, so a path cannot slip into a protected dir via traversal', async () => {
  await withTmp(async (at) => {
    expect(codeOf(await deleteEntry(at('..', '..', '..', '..', '..', '..', '..', 'etc'), { permanent: true }))).toBe('EACCES')
    expect(codeOf(await renameEntry(at('nope'), at('sub', '..', 'x'), {}))).toBe('ENOENT')
  })
})

// ---- rename ----

test('rename: moves, EEXIST by default (both files intact), overwrite replaces', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a'), 'A')
    await fs.writeFile(at('b'), 'B')
    expect(codeOf(await renameEntry(at('a'), at('b'), {}))).toBe('EEXIST')
    expect(await read(at('a'))).toBe('A')
    expect(await read(at('b'))).toBe('B')
    expect(codeOf(await renameEntry(at('a'), at('c'), {}))).toBe('ok')
    expect(await read(at('c'))).toBe('A')
    expect(codeOf(await renameEntry(at('c'), at('b'), { overwrite: true }))).toBe('ok')
    expect(await read(at('b'))).toBe('A')
    expect(await exists(at('c'))).toBe(false)
  })
})

test('rename: letter-case-only change is allowed without overwrite', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('Foo.txt'), 'F')
    expect(codeOf(await renameEntry(at('Foo.txt'), at('foo.txt'), {}))).toBe('ok')
    expect((await fs.readdir(at())).join(',')).toBe('foo.txt')
    expect(await read(at('foo.txt'))).toBe('F')
  })
})

test('rename: a folder into itself (or a descendant) is EINVAL and nothing moves', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d', 'in'), { recursive: true })
    expect(codeOf(await renameEntry(at('d'), at('d', 'in', 'd'), {}))).toBe('EINVAL')
    expect(codeOf(await renameEntry(at('d'), at('d', 'x'), { overwrite: true }))).toBe('EINVAL')
    await fs.symlink(at('d'), at('alias'))
    expect(codeOf(await renameEntry(at('d'), at('alias', 'in', 'z'), {}))).toBe('EINVAL')
    expect(await exists(at('d', 'in'))).toBe(true)
  })
})

test('rename: missing source and missing destination folder are ENOENT; read-only parent is EACCES', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a'), 'A')
    expect(codeOf(await renameEntry(at('ghost'), at('x'), {}))).toBe('ENOENT')
    expect(codeOf(await renameEntry(at('a'), at('nodir', 'x'), {}))).toBe('ENOENT')
    if (isRoot) return
    await fs.mkdir(at('ro'))
    await fs.writeFile(at('ro', 'f'), 'x')
    await fs.chmod(at('ro'), 0o555)
    try {
      expect(codeOf(await renameEntry(at('ro', 'f'), at('g'), {}))).toBe('EACCES')
      expect(codeOf(await renameEntry(at('a'), at('ro', 'a'), {}))).toBe('EACCES')
    } finally {
      await fs.chmod(at('ro'), 0o755)
    }
    expect(await read(at('a'))).toBe('A')
  })
})

// ---- copy ----

test('copy is recursive, keeps file modes, and copies symlinks as links without following them out', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('outside'))
    await fs.writeFile(at('outside', 'secret'), 'S')
    await fs.mkdir(at('src', 'sub'), { recursive: true })
    await fs.writeFile(at('src', 'a.txt'), 'A')
    await fs.writeFile(at('src', 'sub', 'run.sh'), '#!/bin/sh', { mode: 0o755 })
    await fs.symlink(at('outside'), at('src', 'escape'))
    await fs.symlink('a.txt', at('src', 'rel'))
    expect(codeOf(await copyEntry(at('src'), at('dst')))).toBe('ok')
    expect(await read(at('dst', 'a.txt'))).toBe('A')
    expect(((await fs.stat(at('dst', 'sub', 'run.sh'))).mode & 0o777).toString(8)).toBe('755')
    expect((await fs.lstat(at('dst', 'escape'))).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(at('dst', 'escape'))).toBe(at('outside'))
    expect(await fs.readlink(at('dst', 'rel'))).toBe('a.txt')
    expect(await read(at('src', 'a.txt'))).toBe('A')
    expect((await fs.readdir(at('outside'))).join(',')).toBe('secret')
  })
})

test('copy of a symlink to a directory copies the link, not the directory contents', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('real'))
    await fs.writeFile(at('real', 'f'), 'x')
    await fs.symlink(at('real'), at('ln'))
    expect(codeOf(await copyEntry(at('ln'), at('ln2')))).toBe('ok')
    expect((await fs.lstat(at('ln2'))).isSymbolicLink()).toBe(true)
  })
})

test('copy onto an existing file/folder/dangling link is EEXIST and never merges or overwrites', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('f'), 'NEW')
    await fs.writeFile(at('g'), 'KEEP')
    expect(codeOf(await copyEntry(at('f'), at('g')))).toBe('EEXIST')
    expect(await read(at('g'))).toBe('KEEP')
    await fs.mkdir(at('src'))
    await fs.writeFile(at('src', 'new.txt'), 'n')
    await fs.mkdir(at('dst'))
    await fs.writeFile(at('dst', 'old.txt'), 'o')
    expect(codeOf(await copyEntry(at('src'), at('dst')))).toBe('EEXIST')
    expect((await fs.readdir(at('dst'))).join(',')).toBe('old.txt')
    await fs.symlink(at('nowhere'), at('dangling'))
    expect(codeOf(await copyEntry(at('f'), at('dangling')))).toBe('EEXIST')
    expect(await exists(at('nowhere'))).toBe(false)
  })
})

test('copy: a folder into itself is EINVAL; missing source/destination parent are ENOENT', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d', 'in'), { recursive: true })
    expect(codeOf(await copyEntry(at('d'), at('d', 'in', 'copy')))).toBe('EINVAL')
    expect(await exists(at('d', 'in', 'copy'))).toBe(false)
    expect(codeOf(await copyEntry(at('ghost'), at('x')))).toBe('ENOENT')
    expect(codeOf(await copyEntry(at('d'), at('nodir', 'x')))).toBe('ENOENT')
  })
})

test('copy that fails midway (unreadable file) removes its partial copy and keeps the source', async () => {
  if (isRoot) return
  await withTmp(async (at) => {
    await fs.mkdir(at('src'))
    await fs.writeFile(at('src', 'a'), 'A')
    await fs.writeFile(at('src', 'z'), 'Z')
    await fs.chmod(at('src', 'z'), 0o000)
    try {
      expect(codeOf(await copyEntry(at('src'), at('dst')))).toBe('EACCES')
      expect(await exists(at('dst'))).toBe(false)
      expect(await read(at('src', 'a'))).toBe('A')
    } finally {
      await fs.chmod(at('src', 'z'), 0o600)
    }
  })
})

test('restoreEntry output is a trash entry that lookupTrash no longer finds', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('r.txt'), 'r')
    const id = trashIdOf(await deleteEntry(at('r.txt'), {}))
    expect(codeOf(await restoreEntry(id))).toBe('ok')
    const gone = await lookupTrash(id)
    expect('ok' in gone ? gone.code : 'found').toBe('ENOENT')
    expect(codeOf(await restoreEntry(id))).toBe('ENOENT')
  })
})
