// Direktori temporer NYATA, bukan mock fs: yang diuji di sini adalah perilaku terhadap
// filesystem (urutan readdir, batas ukuran, `git check-ignore`), dan fs yang dimock hanya akan
// menguji mock-nya sendiri.
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FS_READ_BINARY_MAX_BYTES, FS_READ_MAX_BYTES, tooLargeSize } from '../shared/fsLimits'
import {
  checkFsPath,
  expandHomePath,
  listDir,
  listDirV2,
  pathExists,
  readBinary,
  readErrorResult,
  readText,
  readTextMeta,
  resolveFsPath,
  statMeta,
} from './fsOps'

let root = ''

beforeAll(async () => {
  root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fsops-'))
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

const at = (...segs: string[]): string => npath.join(root, ...segs)

describe('expandHomePath', () => {
  // `home` dikirim eksplisit supaya test tidak bergantung pada HOME mesin yang menjalankannya.
  it('expands a bare ~ and ~/…', () => {
    expect(expandHomePath('~', '/h/me')).toBe('/h/me')
    expect(expandHomePath('~/src/a.ts', '/h/me')).toBe('/h/me/src/a.ts')
  })

  // `~user` adalah nama user lain, bukan path home-relative — sama seperti nodeterm.
  it('leaves ~user and absolute paths alone', () => {
    expect(expandHomePath('~bob/x', '/h/me')).toBe('~bob/x')
    expect(expandHomePath('/etc/hosts', '/h/me')).toBe('/etc/hosts')
  })
})

describe('resolveFsPath', () => {
  it('normalizes traversal and trailing separators', () => {
    expect(resolveFsPath('/a/b/../c/', '/h/me')).toBe('/a/c')
    expect(resolveFsPath('~/a/./b', '/h/me')).toBe('/h/me/a/b')
  })
})

describe('listDir', () => {
  beforeAll(async () => {
    await fs.mkdir(at('plain', 'zeta'), { recursive: true })
    await fs.mkdir(at('plain', 'alpha'))
    await fs.mkdir(at('plain', '.git'))
    await fs.writeFile(at('plain', 'b.txt'), 'b')
    await fs.writeFile(at('plain', 'A.txt'), 'a')
    await fs.mkdir(at('empty'))
  })

  it('lists folders first, then files, each alphabetical', async () => {
    const entries = await listDir(at('plain'))
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'zeta', 'A.txt', 'b.txt'])
    expect(entries.map((e) => e.dir)).toEqual([true, true, false, false])
  })

  it('hides .git', async () => {
    const entries = await listDir(at('plain'))
    expect(entries.some((e) => e.name === '.git')).toBe(false)
  })

  // Kontrak fail-open yang diandalkan `classifyEmptyListing`: direktori yang HILANG dan direktori
  // yang KOSONG sama-sama `[]`, sehingga client harus bertanya ke induk untuk membedakannya.
  it('answers [] for a missing directory, indistinguishably from an empty one', async () => {
    expect(await listDir(at('nope'))).toEqual([])
    expect(await listDir(at('empty'))).toEqual([])
  })

  it('answers [] for a path that is a file, without throwing', async () => {
    expect(await listDir(at('plain', 'b.txt'))).toEqual([])
  })

  it('leaves `ignored` false outside a git repository', async () => {
    const entries = await listDir(at('plain'))
    expect(entries.every((e) => e.ignored === false)).toBe(true)
  })

  it('flags git-ignored entries in a repository', async () => {
    const repo = at('repo')
    await fs.mkdir(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    await fs.writeFile(npath.join(repo, '.gitignore'), 'dist\nsecret.txt\n')
    await fs.mkdir(npath.join(repo, 'dist'))
    await fs.mkdir(npath.join(repo, 'src'))
    await fs.writeFile(npath.join(repo, 'secret.txt'), 'x')
    await fs.writeFile(npath.join(repo, 'keep.txt'), 'x')

    const byName = new Map((await listDir(repo)).map((e) => [e.name, e.ignored]))
    expect(byName.get('dist')).toBe(true)
    expect(byName.get('secret.txt')).toBe(true)
    expect(byName.get('src')).toBe(false)
    expect(byName.get('keep.txt')).toBe(false)
  })
})

describe('readText', () => {
  it('reads utf-8 content, multibyte included', async () => {
    await fs.writeFile(at('utf.txt'), 'héllo — ok')
    expect(await readText(at('utf.txt'))).toBe('héllo — ok')
  })

  // Kontrak sengaja berbeda dari `listDir`: untuk isi file, `''` adalah jawaban SAH (file yang
  // memang kosong), jadi kegagalan baca harus terlihat sebagai kegagalan — kalau tidak, editor
  // membuka buffer kosong dan Save menimpa file aslinya.
  it('reports a missing file as a failure, not as empty content', async () => {
    await expect(readText(at('ghost.txt'))).rejects.toThrow(/^fs read failed: /)
  })

  // File sparse: `truncate` membuat ukuran 10 MB + 1 byte tanpa benar-benar menulisnya, jadi test
  // ini menekan batas sungguhan dengan biaya mendekati nol.
  it('refuses a file over the text cap with a size-carrying sentinel', async () => {
    const big = at('big.log')
    await fs.writeFile(big, '')
    await fs.truncate(big, FS_READ_MAX_BYTES + 1)
    const out = await readText(big)
    expect(tooLargeSize(out)).toBe(FS_READ_MAX_BYTES + 1)
  })

  it('reads a file exactly at the cap', async () => {
    const edge = at('edge.log')
    await fs.writeFile(edge, '')
    await fs.truncate(edge, FS_READ_MAX_BYTES)
    expect(tooLargeSize(await readText(edge))).toBeNull()
  })
})

describe('readBinary', () => {
  it('round-trips bytes through base64', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x7f])
    await fs.writeFile(at('blob.bin'), bytes)
    expect(Buffer.from(await readBinary(at('blob.bin')), 'base64').equals(bytes)).toBe(true)
  })

  it('reports a missing file as a failure, not as empty content', async () => {
    await expect(readBinary(at('ghost.bin'))).rejects.toThrow(/^fs read-binary failed: /)
  })

  // Cap biner lebih tinggi dari cap teks, jadi file yang ditolak sebagai teks masih boleh dibaca
  // sebagai biner — kedua cap diperiksa terpisah.
  it('uses its own, higher cap', async () => {
    const mid = at('mid.bin')
    await fs.writeFile(mid, '')
    await fs.truncate(mid, FS_READ_MAX_BYTES + 1)
    expect(tooLargeSize(await readBinary(mid))).toBeNull()

    const huge = at('huge.bin')
    await fs.writeFile(huge, '')
    await fs.truncate(huge, FS_READ_BINARY_MAX_BYTES + 1)
    expect(tooLargeSize(await readBinary(huge))).toBe(FS_READ_BINARY_MAX_BYTES + 1)
  })
})

describe('pathExists', () => {
  it('answers for files, dirs and neither', async () => {
    await fs.mkdir(at('deep'))
    await fs.writeFile(at('new.txt'), 'hi')
    expect(await pathExists(at('new.txt'))).toBe(true)
    expect(await pathExists(at('deep'))).toBe(true)
    expect(await pathExists(at('nothing-here'))).toBe(false)
  })
})

describe('checkFsPath', () => {
  it('normalizes absolute and ~ paths', () => {
    expect(checkFsPath('/a/b/../c', '/h/me')).toBe('/a/c')
    expect(checkFsPath('~/x', '/h/me')).toBe('/h/me/x')
  })

  it('rejects relative paths, NUL and over-long names with a coded failure', () => {
    expect(checkFsPath('rel/x')).toMatchObject({ ok: false, code: 'EINVAL' })
    expect(checkFsPath('/a/b\0c')).toMatchObject({ ok: false, code: 'EINVAL' })
    expect(checkFsPath(`/a/${'x'.repeat(256)}`)).toMatchObject({ ok: false, code: 'ENAMETOOLONG' })
    expect(checkFsPath(`/a/${'x'.repeat(255)}`)).toBe(`/a/${'x'.repeat(255)}`)
    // 128 karakter 2-byte = 256 byte: panjang dihitung dalam BYTE, bukan karakter.
    expect(checkFsPath(`/a/${'é'.repeat(128)}`)).toMatchObject({ ok: false, code: 'ENAMETOOLONG' })
  })
})

describe('listDirV2', () => {
  beforeAll(async () => {
    const d = at('v2')
    await fs.mkdir(npath.join(d, 'dir10'), { recursive: true })
    await fs.mkdir(npath.join(d, 'dir2'))
    await fs.mkdir(npath.join(d, '.git'))
    await fs.writeFile(npath.join(d, 'f10.txt'), '0123456789')
    await fs.writeFile(npath.join(d, 'f2.txt'), 'ab')
    await fs.symlink(npath.join(d, 'dir2'), npath.join(d, 'link-dir'))
    await fs.symlink(npath.join(d, 'f2.txt'), npath.join(d, 'link-file'))
    await fs.symlink(npath.join(d, 'ghost'), npath.join(d, 'link-broken'))
  })

  it('sorts natural-numeric with folders first, hides .git, and resolves symlinks', async () => {
    const r = await listDirV2(at('v2'))
    if (!r.ok) throw new Error('listDirV2 failed')
    expect(r.truncated).toBe(false)
    // symlink ke dir dihitung folder (dir:true) dan ikut kelompok folder.
    expect(r.entries.map((e) => e.name)).toEqual(['dir2', 'dir10', 'link-dir', 'f2.txt', 'f10.txt', 'link-broken', 'link-file'])
    const by = new Map(r.entries.map((e) => [e.name, e]))
    expect(by.get('link-dir')).toMatchObject({ dir: true, kind: 'symlink-dir' })
    expect(by.get('link-file')).toMatchObject({ dir: false, kind: 'symlink-file', size: 2 })
    expect(by.get('link-broken')).toMatchObject({ dir: false, kind: 'symlink-broken' })
    expect(by.get('f10.txt')).toMatchObject({ kind: 'file', size: 10, ignored: false })
    expect(typeof by.get('f10.txt')?.mtimeMs).toBe('number')
  })

  it('caps at limit and reports truncated', async () => {
    const r = await listDirV2(at('v2'), 3)
    if (!r.ok) throw new Error('listDirV2 failed')
    expect(r.entries.map((e) => e.name)).toEqual(['dir2', 'dir10', 'link-dir'])
    expect(r.truncated).toBe(true)
  })

  it('does not fail on >2000 entries (git check-ignore is skipped)', async () => {
    const d = at('many')
    await fs.mkdir(d)
    await Promise.all(Array.from({ length: 2100 }, (_, i) => fs.writeFile(npath.join(d, `f${i}`), '')))
    const r = await listDirV2(d)
    if (!r.ok) throw new Error('listDirV2 failed')
    expect(r.entries.length).toBe(2100)
    expect(r.entries.every((e) => !e.ignored)).toBe(true)
  })

  it('answers a coded failure (not []) for a missing dir, a file and a relative path', async () => {
    expect(await listDirV2(at('nope'))).toMatchObject({ ok: false, code: 'ENOENT' })
    expect(await listDirV2(at('v2', 'f2.txt'))).toMatchObject({ ok: false, code: 'ENOTDIR' })
    expect(await listDirV2('relative')).toMatchObject({ ok: false, code: 'EINVAL' })
  })
})

describe('readTextMeta', () => {
  it('reads utf-8 with a version, and the version changes when content changes', async () => {
    await fs.writeFile(at('m.txt'), 'héllo')
    const a = await readTextMeta(at('m.txt'))
    expect(a).toMatchObject({ content: 'héllo', encoding: 'utf8' })
    expect(a.version).toMatch(/^\d+-6$/)
    await fs.writeFile(at('m.txt'), 'héllo!')
    expect((await readTextMeta(at('m.txt'))).version).not.toBe(a.version)
  })

  it('classifies NUL as binary (empty content) and invalid utf-8 as non-utf8 (lossy content)', async () => {
    await fs.writeFile(at('b.dat'), Buffer.from([0x68, 0x00, 0x69]))
    expect(await readTextMeta(at('b.dat'))).toMatchObject({ content: '', encoding: 'binary' })
    await fs.writeFile(at('l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])) // "café" Latin-1
    expect(await readTextMeta(at('l1.txt'))).toMatchObject({ content: 'caf\ufffd', encoding: 'non-utf8' })
  })

  it('keeps the BOM and returns the too-large sentinel with a version', async () => {
    await fs.writeFile(at('bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
    expect((await readTextMeta(at('bom.txt'))).content).toBe('\ufeffa')
    await fs.writeFile(at('big2.log'), '')
    await fs.truncate(at('big2.log'), FS_READ_MAX_BYTES + 1)
    const r = await readTextMeta(at('big2.log'))
    expect(tooLargeSize(r.content)).toBe(FS_READ_MAX_BYTES + 1)
    expect(r.version).not.toBe('')
  })

  it('still throws (contract 2): missing, directory, relative path', async () => {
    await expect(readTextMeta(at('ghost.txt'))).rejects.toThrow(/^fs read failed: /)
    const dirErr = await readTextMeta(at('deep')).catch((e: unknown) => e)
    expect(readErrorResult(dirErr).status).toBe(400)
    const relErr = await readTextMeta('rel.txt').catch((e: unknown) => e)
    expect(readErrorResult(relErr).status).toBe(400)
    expect(readErrorResult(relErr).body.error).toBe('invalid path')
  })
})

describe('statMeta', () => {
  it('returns meta + version for file, dir and symlink; FsFail for missing/relative', async () => {
    const f = await statMeta(at('m.txt'))
    expect(f).toMatchObject({ ok: true, meta: { name: 'm.txt', dir: false, kind: 'file', size: 7 } })
    if (f.ok) expect(f.version).toBe((await readTextMeta(at('m.txt'))).version)
    expect(await statMeta(at('deep'))).toMatchObject({ ok: true, meta: { dir: true, kind: 'dir' } })
    expect(await statMeta(at('v2', 'link-dir'))).toMatchObject({ ok: true, meta: { dir: true, kind: 'symlink-dir' } })
    expect(await statMeta(at('v2', 'link-broken'))).toMatchObject({ ok: true, version: '', meta: { kind: 'symlink-broken' } })
    expect(await statMeta(at('ghost'))).toMatchObject({ ok: false, code: 'ENOENT' })
    expect(await statMeta('rel')).toMatchObject({ ok: false, code: 'EINVAL' })
  })
})
