// gitMarks (WS-FM-08) terhadap repo git sementara di $TMPDIR.
import { afterAll, expect, test as it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename as npathBase, join } from 'node:path'
import { gitMarks, parseBranch, parseStatus, resolveGitDir } from './fsGit'

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

/** Fresh repo with one commit on `main`; returns its path and a git runner bound to it. */
function freshRepo(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const run = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString()
  run('init', '-q', '-b', 'main')
  return { dir, run }
}

it('ignored: files and folders get I, folders never roll up an ignored child', async () => {
  const { dir, run } = freshRepo('fsgit-ign-')
  try {
    writeFileSync(join(dir, '.gitignore'), '*.log\nbuild/\n')
    mkdirSync(join(dir, 'build')); writeFileSync(join(dir, 'build/out.js'), 'x')
    mkdirSync(join(dir, 'logs')); writeFileSync(join(dir, 'logs/a.log'), 'x'); writeFileSync(join(dir, 'logs/keep.txt'), 'x')
    writeFileSync(join(dir, 'top.log'), 'x')
    run('add', '-A'); run('commit', '-q', '-m', 'init')
    const r = await gitMarks(dir)
    if (!r.ok) throw new Error(r.error)
    expect(r.marks['top.log']).toBe('I')
    expect(r.marks['build']).toBe('I')
    expect(r.marks['logs/a.log']).toBe('I')
    expect(r.marks['logs']).toBe(undefined) // clean folder with only an ignored child: no dot
    writeFileSync(join(dir, 'logs/keep.txt'), 'changed')
    const r2 = await gitMarks(dir)
    if (!r2.ok) throw new Error(r2.error)
    expect(r2.marks['logs']).toBe('M') // a real change still rolls up past the ignored sibling
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('branch headers: name, upstream ahead/behind, detached short oid; absent outside a repo', async () => {
  const { dir, run } = freshRepo('fsgit-br-')
  try {
    writeFileSync(join(dir, 'a.txt'), '1'); run('add', '-A'); run('commit', '-q', '-m', 'one')
    run('branch', 'base')
    writeFileSync(join(dir, 'a.txt'), '2'); run('commit', '-qam', 'two')
    writeFileSync(join(dir, 'a.txt'), '3'); run('commit', '-qam', 'three')
    run('branch', '--set-upstream-to=base')
    const r = await gitMarks(dir)
    if (!r.ok) throw new Error(r.error)
    expect(JSON.stringify(r.branch && { ...r.branch, head: r.branch.head.length })).toBe(JSON.stringify({ branch: 'main', head: 8, upstream: 'base', ahead: 2, behind: 0 }))
    run('checkout', '-q', '--detach', 'base')
    const d = await gitMarks(dir)
    if (!d.ok) throw new Error(d.error)
    expect(d.branch?.branch).toBe(null)
    expect(run('rev-parse', 'HEAD').startsWith(d.branch?.head ?? '-')).toBe(true)
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'fsgit-nobr-')))
    try {
      const n = await gitMarks(plain)
      expect(n.ok && n.branch).toBe(undefined)
    } finally { rmSync(plain, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('parseStatus: ! record -> I; parseBranch reads -z headers', () => {
  expect(JSON.stringify(parseStatus(['! node_modules/', '? u.txt', ''].join('\0')))).toBe(JSON.stringify([['node_modules/', 'I'], ['u.txt', 'U']]))
  const out = ['# branch.oid 0123456789abcdef', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +3 -4', '? x', ''].join('\0')
  expect(JSON.stringify(parseBranch(out))).toBe(JSON.stringify({ branch: 'feat', head: '01234567', upstream: 'origin/feat', ahead: 3, behind: 4 }))
  expect(parseBranch('? x\0')).toBe(null)
})

it('resolveGitDir: main repo -> .git, linked worktree (.git file) -> .git/worktrees/<name> sharing the main .git, plain dir -> null', async () => {
  const { dir, run } = freshRepo('fsgit-wt-')
  const wt = `${dir}-linked`
  try {
    writeFileSync(join(dir, 'a.txt'), '1'); run('add', '-A'); run('commit', '-q', '-m', 'one')
    run('worktree', 'add', '-q', wt)
    const git = join(dir, '.git')
    expect(JSON.stringify(await resolveGitDir(dir))).toBe(JSON.stringify({ gitDir: git, commonDir: git }))
    mkdirSync(join(dir, 'sub'))
    expect(JSON.stringify(await resolveGitDir(join(dir, 'sub')))).toBe(JSON.stringify({ gitDir: git, commonDir: git })) // relative common dir resolved
    expect(JSON.stringify(await resolveGitDir(wt))).toBe(JSON.stringify({ gitDir: join(git, 'worktrees', npathBase(wt)), commonDir: git }))
    expect(await resolveGitDir(tmpdir())).toBe(null)
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
})
