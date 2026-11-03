// gitMarks (WS-FM-08) terhadap repo git sementara di $TMPDIR.
import { afterAll, expect, test as it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitMarks, parseStatus } from './fsGit'

let root = ''
const git = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
const put = (rel: string, body = 'x') => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body) }
const marks = async (sub = '') => {
  const r = await gitMarks(join(root, sub))
  if (!r.ok) throw new Error(r.error)
  return r.marks
}

{
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fsgit-')))
  git('init', '-q')
  for (const f of ['mod.txt', 'del.txt', 'old name.txt', 'sub/deep/in.txt', 'sub/other.txt', 'ünï cödé.txt', 'nl\nname.txt']) put(f, 'base content for rename detection')
  git('add', '-A'); git('commit', '-q', '-m', 'init')
  put('mod.txt', 'changed'); unlinkSync(join(root, 'del.txt'))
  put('added.txt'); git('add', 'added.txt')
  put('untracked.txt'); put('newdir/a.txt')
  renameSync(join(root, 'old name.txt'), join(root, 'new name.txt')); git('add', '-A', 'old name.txt', 'new name.txt')
  put('sub/deep/in.txt', 'changed'); put('ünï cödé.txt', 'changed'); put('sub/deep/new.txt'); unlinkSync(join(root, 'sub/other.txt')); put('nl\nname.txt', 'changed')
}
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('M/A/D/U/R terparse, nama spasi/unicode/newline benar', async () => {
  const m = await marks()
  expect(m['mod.txt']).toBe('M')
  expect(m['del.txt']).toBe('D')
  expect(m['added.txt']).toBe('A')
  expect(m['untracked.txt']).toBe('U')
  expect(m['new name.txt']).toBe('R')
  expect(m['old name.txt']).toBe(undefined)
  expect(m['ünï cödé.txt'].normalize('NFC')).toBe('M')
  expect(m['nl\nname.txt']).toBe('M')
})

it('rollup folder = mark terkuat anak (D menang atas M/U), folder untracked = U', async () => {
  const m = await marks()
  expect(m['newdir']).toBe('U')
  expect(m['sub']).toBe('D')
  expect(m['sub/deep']).toBe('M')
})

it('subfolder: path relatif ke dir, bukan ke root repo; di luar dir tak ikut', async () => {
  const m = await marks('sub')
  expect(m['deep']).toBe('M')
  expect(m['deep/in.txt']).toBe('M')
  expect(m['other.txt']).toBe('D')
  expect(m['mod.txt']).toBe(undefined)
})

it('bukan repo / dir tak ada -> marks kosong tanpa error', async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'fsgit-plain-')))
  try {
    expect(JSON.stringify(await gitMarks(plain))).toBe('{"ok":true,"marks":{}}')
    expect(JSON.stringify(await gitMarks(join(plain, 'tidak-ada')))).toBe('{"ok":true,"marks":{}}')
  } finally { rmSync(plain, { recursive: true, force: true }) }
})

it('path relatif ditolak EINVAL', async () => {
  const r = await gitMarks('relative/x')
  expect(r.ok).toBe(false)
})

it('parseStatus: konflik u -> C, rename 2 memakan path asal, cap entri', () => {
  const out = ['u UU N... 100644 100644 100644 100644 h h h conflict file.txt', '2 R. N... 100644 100644 100644 h h R100 to new.txt', 'from old.txt', '1 .M N... 100644 100644 100644 h h x y.txt', '? u.txt', ''].join('\0')
  expect(JSON.stringify(parseStatus(out))).toBe(JSON.stringify([['conflict file.txt', 'C'], ['to new.txt', 'R'], ['x y.txt', 'M'], ['u.txt', 'U']]))
  const many = Array.from({ length: 6000 }, (_, i) => `? f${i}`).join('\0')
  expect(parseStatus(many).length).toBe(5000)
})
