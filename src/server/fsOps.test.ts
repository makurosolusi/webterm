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
  expandHomePath,
  listDir,
  makeDir,
  pathExists,
  readBinary,
  readText,
  resolveFsPath,
  writeText,
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

describe('writeText / makeDir / pathExists', () => {
  it('writes a file and reads it back', async () => {
    expect(await writeText(at('new.txt'), 'hi')).toBe(true)
    expect(await readText(at('new.txt'))).toBe('hi')
  })

  it('reports false rather than throwing when the parent does not exist', async () => {
    expect(await writeText(at('no', 'such', 'f.txt'), 'hi')).toBe(false)
  })

  it('creates nested directories (mkdir -p)', async () => {
    expect(await makeDir(at('deep', 'a', 'b'))).toBe(true)
    expect(await pathExists(at('deep', 'a', 'b'))).toBe(true)
  })

  it('is idempotent for an existing directory', async () => {
    expect(await makeDir(at('deep', 'a'))).toBe(true)
  })

  it('reports false for a directory whose name is taken by a file', async () => {
    await fs.writeFile(at('taken'), 'x')
    expect(await makeDir(at('taken'))).toBe(false)
  })

  it('answers pathExists for files, dirs and neither', async () => {
    expect(await pathExists(at('new.txt'))).toBe(true)
    expect(await pathExists(at('deep'))).toBe(true)
    expect(await pathExists(at('nothing-here'))).toBe(false)
  })
})
