// `gitDiff.ts` + its route against REAL git repos in temp dirs (same fixture style as
// gitInfo.bun.test.ts). Never touches a user repo: every repo is created under $TMPDIR and removed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { gitDiffRoute } from './gitDiff.route'
import { parseHunks } from './gitDiff'
import { GIT_DIFF_PATH, GIT_DIFF_UNDO_PATH, type GitDiffList, type GitFileDiff } from './gitDiff.types'
import { GIT_CAPABILITIES } from './capability/git.capabilities'
import { capabilityProblems } from './capability/capability.define'

const run = promisify(execFile)
const T = 30_000

let root = ''
const at = (p: string) => npath.join(root, p)
const write = (p: string, s: string | Uint8Array) => fs.mkdir(npath.dirname(at(p)), { recursive: true }).then(() => fs.writeFile(at(p), s))
const g = (...args: string[]) => run('git', args, {
  cwd: root,
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' },
})
const noBody = () => Promise.resolve('')

async function list(q = ''): Promise<{ status: number; body: GitDiffList }> {
  return (await gitDiffRoute(GIT_DIFF_PATH, 'GET', new URLSearchParams(`root=${encodeURIComponent(root)}${q}`), noBody)) as never
}
async function file(path: string): Promise<{ status: number; body: GitFileDiff }> {
  return (await gitDiffRoute(GIT_DIFF_PATH, 'GET', new URLSearchParams({ root, path }), noBody)) as never
}
async function undo(path: string, hunkId: string): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  return (await gitDiffRoute(GIT_DIFF_UNDO_PATH, 'POST', new URLSearchParams(), () => Promise.resolve(JSON.stringify({ root, path, hunkId })))) as never
}

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-diff-')))
  await g('init', '-q', '-b', 'main')
  await write('mod.txt', LINES.join('\n') + '\n')
  await write('gone.txt', 'bye\n')
  await write('img.bin', new Uint8Array([0, 1, 2, 0, 3]))
  await write('.env', 'SECRET=old\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'init')
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

test('lists added, modified, deleted, binary, untracked and sensitive files', async () => {
  const m = [...LINES]; m[1] = 'CHANGED 2'; m[35] = 'CHANGED 36'
  await write('mod.txt', m.join('\n') + '\n')
  await fs.rm(at('gone.txt'))
  await write('img.bin', new Uint8Array([0, 9, 9, 0]))
  await write('new.txt', 'hello\n')
  await g('add', 'new.txt')
  await write('loose.txt', 'untracked\n')
  await write('.env', 'SECRET=new\n')
  const { status, body } = await list()
  expect(status).toBe(200)
  const by = Object.fromEntries(body.files.map((f) => [f.path, f]))
  expect(Object.keys(by).sort()).toEqual(['.env', 'gone.txt', 'img.bin', 'loose.txt', 'mod.txt', 'new.txt'])
  expect(by['mod.txt'].status).toBe('modified')
  expect(by['gone.txt'].status).toBe('deleted')
  expect(by['new.txt'].status).toBe('added')
  expect(by['loose.txt'].status).toBe('untracked')
  expect(by['img.bin'].binary).toBe(true)
  expect(by['.env'].sensitive).toBe(true)
  expect(body.total).toBe(6)
  expect(body.nextOffset).toBeNull()

  const mod = (await file('mod.txt')).body
  expect(mod.original).toContain('line 2\n')
  expect(mod.modified).toContain('CHANGED 2')
  expect(mod.hunks.length).toBe(2)
  expect(mod.undoable).toBe(true)
  const added = (await file('new.txt')).body
  expect(added.original).toBe('')
  expect(added.modified).toBe('hello\n')
  const del = (await file('gone.txt')).body
  expect(del.modified).toBe('')
  expect(del.original).toBe('bye\n')
  const bin = (await file('img.bin')).body
  expect(bin.binary).toBe(true)
  expect(bin.original + bin.modified).toBe('')
}, T)

test('never serves the contents of a sensitive file, nor undoes it', async () => {
  await write('.env', 'SECRET=new\n')
  const r = await file('.env')
  expect(r.status).toBe(200)
  expect(r.body.sensitive).toBe(true)
  expect(JSON.stringify(r.body)).not.toContain('SECRET')
  expect(r.body.hunks).toEqual([])
  expect((await undo('.env', 'whatever')).status).toBe(403)
}, T)

test('paginates the file list', async () => {
  for (let i = 0; i < 25; i++) await write(`many/f${String(i).padStart(2, '0')}.txt`, `${i}\n`)
  const p1 = await list('&limit=10')
  expect(p1.body.files.length).toBe(10)
  expect(p1.body.total).toBe(25)
  expect(p1.body.nextOffset).toBe(10)
  const p3 = await list('&offset=20&limit=10')
  expect(p3.body.files.map((f) => f.path)).toEqual(['many/f20.txt', 'many/f21.txt', 'many/f22.txt', 'many/f23.txt', 'many/f24.txt'])
  expect(p3.body.nextOffset).toBeNull()
  expect((await list('&limit=0')).status).toBe(400)
  expect((await list('&limit=99999')).status).toBe(400)
}, T)

test('withholds contents of a file larger than the cap', async () => {
  await write('big.txt', 'x'.repeat(1024 * 1024 + 10))
  const r = await file('big.txt')
  expect(r.body.truncated).toBe(true)
  expect(r.body.modified).toBe('')
}, T)

test('undo reverts exactly one hunk', async () => {
  const m = [...LINES]; m[1] = 'CHANGED 2'; m[35] = 'CHANGED 36'
  await write('mod.txt', m.join('\n') + '\n')
  const { hunks } = (await file('mod.txt')).body
  const r = await undo('mod.txt', hunks[0].id)
  expect(r).toEqual({ status: 200, body: { ok: true } })
  const now = await fs.readFile(at('mod.txt'), 'utf8')
  expect(now).toContain('line 2\n')
  expect(now).toContain('CHANGED 36')
  expect((await file('mod.txt')).body.hunks.length).toBe(1)
}, T)

test('undo of a deleted file restores it', async () => {
  await fs.rm(at('gone.txt'))
  const { hunks } = (await file('gone.txt')).body
  expect((await undo('gone.txt', hunks[0].id)).status).toBe(200)
  expect(await fs.readFile(at('gone.txt'), 'utf8')).toBe('bye\n')
}, T)

test('undo refuses when the file changed after the diff was loaded', async () => {
  const m = [...LINES]; m[1] = 'CHANGED 2'
  await write('mod.txt', m.join('\n') + '\n')
  const { hunks } = (await file('mod.txt')).body
  m[2] = 'EDITED LATER'
  await write('mod.txt', m.join('\n') + '\n')
  const r = await undo('mod.txt', hunks[0].id)
  expect(r.status).toBe(409)
  expect(r.body.error).toBe('stale')
  expect(await fs.readFile(at('mod.txt'), 'utf8')).toContain('EDITED LATER')
}, T)

test('undo refuses untracked files and rejects escaping paths', async () => {
  await write('loose.txt', 'x\n')
  expect((await undo('loose.txt', 'x')).body.error).toBe('undo_unsupported')
  expect((await file('../etc/passwd')).status).toBe(400)
  expect((await file('/etc/passwd')).status).toBe(400)
}, T)

test('a path outside any repo answers not_a_repo', async () => {
  const out = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-norepo-'))
  try {
    const r = await gitDiffRoute(GIT_DIFF_PATH, 'GET', new URLSearchParams({ root: out }), noBody)
    expect(r?.status).toBe(400)
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
}, T)

test('parseHunks reads ranges, including the omitted-count form', () => {
  const { hunks } = parseHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,3 @@\n c\n+d\n c\n')
  expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[1, 1, 1, 1], [10, 2, 10, 3]])
  expect(new Set(hunks.map((h) => h.id)).size).toBe(2)
})

test('git.diff is a well-formed R0 capability bound to the diff route', () => {
  const [cap] = GIT_CAPABILITIES
  expect(capabilityProblems(cap)).toEqual([])
  expect(cap.name).toBe('git.diff')
  expect(cap.tier).toBe('R0')
  expect(cap.route).toEqual({ method: 'GET', path: GIT_DIFF_PATH })
})
