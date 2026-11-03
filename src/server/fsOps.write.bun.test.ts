// Operasi tulis `fsOps.write.ts` terhadap filesystem NYATA (inode, nlink, mode, errno asli tidak
// bisa dimock). Bun-only; matcher terbatas pada yang diekspos `bun-test.d.ts` (toBe/toContain).
// Regresi M-01 (New File menimpa) dan M-02 (⌘S tanpa cek konflik / membuat ulang file terhapus)
// ditandai di nama test; keduanya GAGAL bila perilaku lama dipulihkan (lihat laporan WS-FM-01).
import { test, expect } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import type { FsResult } from '../shared/fsContract'
import { STALE_TMP_MS } from './fsAtomic'
import { createFileExclusive, makeDirChecked, writeFileChecked } from './fsOps.write'
import { readTextMeta, statMeta } from './fsOps'

async function withTmp(fn: (at: (...s: string[]) => string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-fswrite-'))
  try {
    await fn((...segs: string[]) => npath.join(root, ...segs))
  } finally {
    await fs.chmod(root, 0o755) // satu test mengunci direktori; rm -r butuh aksesnya kembali
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** Kode galat dari sebuah hasil, atau 'ok' bila sukses. */
const codeOf = (r: FsResult<object>): string => (r.ok ? 'ok' : r.code)
const versionOf = (r: FsResult<object>): string => (r.ok ? (r.version ?? '') : 'FAIL')
const tmpLeft = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))

test('M-01 create refuses an existing name and leaves the old content intact', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('a.txt'), 'ORIGINAL')
    const r = await createFileExclusive(at('a.txt'), 'overwritten')
    expect(codeOf(r)).toBe('EEXIST')
    expect(await fs.readFile(at('a.txt'), 'utf8')).toBe('ORIGINAL')
  })
})

test('M-01 concurrent creates of one name: exactly one wins (no check-then-write race)', async () => {
  await withTmp(async (at) => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => createFileExclusive(at('race.txt'), `writer-${i}`)))
    const winners = rs.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0)
    expect(winners.length).toBe(1)
    expect(rs.filter((r) => codeOf(r) === 'EEXIST').length).toBe(11)
    expect(await fs.readFile(at('race.txt'), 'utf8')).toBe(`writer-${winners[0]}`)
  })
})

test('M-01 a differently-cased name is a conflict on a case-insensitive filesystem', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('Case.txt'), 'x')
    const insensitive = await fs.access(at('case.txt')).then(() => true, () => false)
    if (!insensitive) return // FS case-sensitive (Linux/ext4): skenario ini tidak berlaku, tes dilewati
    expect(codeOf(await createFileExclusive(at('case.txt'), 'y'))).toBe('EEXIST')
    expect(await fs.readFile(at('Case.txt'), 'utf8')).toBe('x')
  })
})

test('create writes content, returns the version readTextMeta later reports, and leaves no temp', async () => {
  await withTmp(async (at) => {
    const r = await createFileExclusive(at('n.txt'), 'héllo €')
    expect(codeOf(r)).toBe('ok')
    const meta = await readTextMeta(at('n.txt'))
    expect(meta.content).toBe('héllo €')
    expect(meta.version).toBe(versionOf(r))
    expect(codeOf(await createFileExclusive(at('empty.txt')))).toBe('ok')
    expect(await fs.readFile(at('empty.txt'), 'utf8')).toBe('')
    expect((await tmpLeft(at('.'))).length).toBe(0)
  })
})

test('M-02 a stale expectedVersion is EVERSION with the current version and does not write', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('s.txt'), 'v1')
    const seen = (await readTextMeta(at('s.txt'))).version
    await fs.writeFile(at('s.txt'), 'changed by someone else')
    const r = await writeFileChecked(at('s.txt'), 'mine', { expectedVersion: seen, mustExist: true })
    expect(codeOf(r)).toBe('EVERSION')
    expect(!r.ok && r.current).toBe((await readTextMeta(at('s.txt'))).version)
    expect(await fs.readFile(at('s.txt'), 'utf8')).toBe('changed by someone else')
  })
})

test('M-02 mustExist on a deleted file is ENOENT and the file is NOT recreated', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('gone.txt'), 'v1')
    const seen = (await readTextMeta(at('gone.txt'))).version
    await fs.rm(at('gone.txt'))
    expect(codeOf(await writeFileChecked(at('gone.txt'), 'x', { mustExist: true }))).toBe('ENOENT')
    expect(codeOf(await writeFileChecked(at('gone.txt'), 'x', { expectedVersion: seen }))).toBe('ENOENT')
    expect(await fs.access(at('gone.txt')).then(() => true, () => false)).toBe(false)
    // Tanpa syarat apa pun, write tetap membuat file (kontrak lama `write`).
    expect(codeOf(await writeFileChecked(at('gone.txt'), 'x'))).toBe('ok')
  })
})

test('write chains versions: the returned version is accepted by the next save', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('c.txt'), 'v0')
    let ver = (await readTextMeta(at('c.txt'))).version
    for (const text of ['v1', 'v2 — ünïcode', 'v3']) {
      const r = await writeFileChecked(at('c.txt'), text, { expectedVersion: ver, mustExist: true })
      expect(codeOf(r)).toBe('ok')
      ver = versionOf(r)
      expect(ver).toBe((await readTextMeta(at('c.txt'))).version)
      expect(await fs.readFile(at('c.txt'), 'utf8')).toBe(text)
    }
  })
})

test('atomic write: new inode, mode preserved, no temp left', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('m.sh'), '#!/bin/sh\n')
    await fs.chmod(at('m.sh'), 0o750)
    const before = await fs.stat(at('m.sh'))
    expect(codeOf(await writeFileChecked(at('m.sh'), 'echo hi\n'))).toBe('ok')
    const after = await fs.stat(at('m.sh'))
    expect(after.mode & 0o7777).toBe(0o750)
    expect(after.ino === before.ino).toBe(false) // rename atas temp = inode baru: pembaca lain tak pernah melihat file separuh tulis
    expect((await tmpLeft(at('.'))).length).toBe(0)
  })
})

test('a hardlinked file is written in place (the other link sees the change)', async () => {
  await withTmp(async (at) => {
    await fs.writeFile(at('h1.txt'), 'old')
    await fs.link(at('h1.txt'), at('h2.txt'))
    const ino = (await fs.stat(at('h1.txt'))).ino
    expect(codeOf(await writeFileChecked(at('h1.txt'), 'new'))).toBe('ok')
    expect((await fs.stat(at('h1.txt'))).ino === ino).toBe(true)
    expect(await fs.readFile(at('h2.txt'), 'utf8')).toBe('new')
  })
})

test('writing through a symlink updates the target and keeps the link', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('real'))
    await fs.writeFile(at('real', 't.txt'), 'old')
    await fs.symlink(at('real', 't.txt'), at('link.txt'))
    expect(codeOf(await writeFileChecked(at('link.txt'), 'new'))).toBe('ok')
    expect((await fs.lstat(at('link.txt'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(at('real', 't.txt'), 'utf8')).toBe('new')
    expect((await tmpLeft(at('real'))).length + (await tmpLeft(at('.'))).length).toBe(0)
  })
})

test('a dangling symlink is written through (target created), not replaced', async () => {
  await withTmp(async (at) => {
    await fs.symlink(at('made.txt'), at('dangling'))
    expect(codeOf(await writeFileChecked(at('dangling'), 'x', { mustExist: true }))).toBe('ENOENT')
    expect(codeOf(await writeFileChecked(at('dangling'), 'x'))).toBe('ok')
    expect((await fs.lstat(at('dangling'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(at('made.txt'), 'utf8')).toBe('x')
  })
})

test('falls back to in-place when the directory is not writable but the file is', async () => {
  if (process.getuid?.() === 0) return // root menembus mode bit
  await withTmp(async (at) => {
    await fs.mkdir(at('ro'))
    await fs.writeFile(at('ro', 'f.txt'), 'old')
    await fs.chmod(at('ro'), 0o555)
    try {
      expect(codeOf(await writeFileChecked(at('ro', 'f.txt'), 'new'))).toBe('ok')
      expect(await fs.readFile(at('ro', 'f.txt'), 'utf8')).toBe('new')
    } finally {
      await fs.chmod(at('ro'), 0o755)
    }
  })
})

test('sweeps stale .webterm-*.tmp (older than the threshold) and nothing else', async () => {
  await withTmp(async (at) => {
    const old = new Date(Date.now() - STALE_TMP_MS - 60_000)
    await fs.writeFile(at('.webterm-dead.tmp'), 'x')
    await fs.utimes(at('.webterm-dead.tmp'), old, old)
    await fs.writeFile(at('.webterm-fresh.tmp'), 'x')
    await fs.writeFile(at('.webterm-notes.txt'), 'x')
    await fs.utimes(at('.webterm-notes.txt'), old, old)
    await fs.writeFile(at('plain.tmp'), 'x')
    await fs.utimes(at('plain.tmp'), old, old)
    expect(codeOf(await writeFileChecked(at('w.txt'), 'x'))).toBe('ok')
    const left = (await fs.readdir(at('.'))).sort().join(',')
    expect(left).toBe('.webterm-fresh.tmp,.webterm-notes.txt,plain.tmp,w.txt')
  })
})

test('validation: directory, NUL, relative and over-long names are coded failures', async () => {
  await withTmp(async (at) => {
    await fs.mkdir(at('d'))
    expect(codeOf(await writeFileChecked(at('d'), 'x'))).toBe('EISDIR')
    expect(codeOf(await writeFileChecked(`${at('a')}\0b`, 'x'))).toBe('EINVAL')
    expect(codeOf(await writeFileChecked('relative.txt', 'x'))).toBe('EINVAL')
    expect(codeOf(await createFileExclusive('relative.txt'))).toBe('EINVAL')
    expect(codeOf(await createFileExclusive(at('x'.repeat(256))))).toBe('ENAMETOOLONG')
    expect(codeOf(await writeFileChecked(at('no', 'parent', 'f.txt'), 'x'))).toBe('ENOENT')
    expect((await tmpLeft(at('.'))).length).toBe(0)
  })
})

test('mkdir reports created=true only when the directory is new, EEXIST over a file', async () => {
  await withTmp(async (at) => {
    const first = await makeDirChecked(at('a', 'b'))
    expect(first.ok && first.created).toBe(true)
    const again = await makeDirChecked(at('a', 'b'))
    expect(again.ok && again.created).toBe(false)
    await fs.writeFile(at('file'), 'x')
    expect(codeOf(await makeDirChecked(at('file')))).toBe('EEXIST')
    expect(codeOf(await makeDirChecked('rel'))).toBe('EINVAL')
  })
})

test('statMeta version matches the version write returns', async () => {
  await withTmp(async (at) => {
    const w = await writeFileChecked(at('v.txt'), 'abc')
    const s = await statMeta(at('v.txt'))
    expect(s.ok && s.version).toBe(versionOf(w))
  })
})
