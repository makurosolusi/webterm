// Checkpoints against REAL temp git repos only (never the user's repos): capture, secrets excluded,
// rewind of a shell-made edit, undo, HEAD/branch/index untouched, dedupe, retention, non-git label.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { eventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { listCheckpoints, REF_ROOT, repoOf } from './checkpoint.git'
import { checkpointRoute, CHECKPOINTS_PATH } from './checkpoint.route'
import { Database } from 'bun:sqlite'
import { registerWorkspaceLookup } from '../central/workspaceLookup'
import { checkpointBeforeAction, listWorkspaceCheckpoints, panicSnapshot, panicSnapshotAll, previewWorkspaceRewind, rewindWorkspace, takeCheckpoint } from './checkpoint.service'

const run = promisify(execFile)
const T = 30_000
const GIT_ENV = { // test-only identity, isolated from the user's git config
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'webterm test', GIT_AUTHOR_EMAIL: 't@webterm.test', GIT_COMMITTER_NAME: 'webterm test', GIT_COMMITTER_EMAIL: 't@webterm.test',
}
const g = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, env: GIT_ENV })).stdout
const sh = (cwd: string, script: string) => run('/bin/sh', ['-c', script], { cwd })
const read = (dir: string, f: string) => fs.readFile(npath.join(dir, f), 'utf8')
const exists = (dir: string, f: string) => fs.access(npath.join(dir, f)).then(() => true, () => false)

let dir = ''
let events: SenseEvent[] = []
let unsub = () => {}
const ws = () => ({ id: 'ws-1', cwd: dir })

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-test-')))
  await g(dir, 'init', '-q', '-b', 'main')
  await fs.writeFile(npath.join(dir, '.gitignore'), 'build/\n')
  await fs.writeFile(npath.join(dir, 'a.txt'), 'one\n')
  await g(dir, 'add', '.')
  await g(dir, 'commit', '-q', '-m', 'init')
  events = []
  unsub = eventBus.subscribe('checkpoint.*', (e) => { events.push(e) })
})
afterEach(async () => {
  unsub()
  await fs.rm(dir, { recursive: true, force: true })
})

async function repoState(d: string) {
  return { head: await g(d, 'rev-parse', 'HEAD'), branch: await g(d, 'symbolic-ref', 'HEAD'), index: await g(d, 'ls-files', '-s'), status: await g(d, 'status', '--porcelain'), branches: await g(d, 'branch', '--list') }
}

test('captures modified + untracked files, never ignored or secret ones', async () => {
  await fs.writeFile(npath.join(dir, 'a.txt'), 'two\n')
  await fs.writeFile(npath.join(dir, 'new.txt'), 'fresh\n')
  await fs.mkdir(npath.join(dir, 'build'))
  await fs.writeFile(npath.join(dir, 'build', 'out.js'), 'x')
  await fs.writeFile(npath.join(dir, '.env'), 'TOKEN=test-only\n')
  await fs.writeFile(npath.join(dir, 'id_rsa'), 'test-only\n')
  const res = await takeCheckpoint(ws(), { reason: 'prompt', nodeId: 'n1' })
  if (!res.rewindable) throw new Error('expected a repo')
  const files = (await g(dir, 'ls-tree', '-r', '--name-only', res.checkpoint.commit)).trim().split('\n').sort()
  expect(files).toEqual(['.gitignore', 'a.txt', 'new.txt'])
  expect(await g(dir, 'show', `${res.checkpoint.commit}:a.txt`)).toBe('two\n')
  expect(await g(dir, 'for-each-ref', '--format=%(refname)', REF_ROOT)).toBe(`${REF_ROOT}/ws-1/1\n`)
  expect(res.checkpoint).toMatchObject({ seq: 1, reason: 'prompt', nodeId: 'n1' })
  expect(events.map((e) => [e.kind, e.workspaceId, e.nodeId, (e.payload as { seq: number }).seq])).toEqual([['checkpoint.created', 'ws-1', 'n1', 1]])
}, T)

test('a tracked secret is excluded from the snapshot and never touched by rewind', async () => {
  await fs.writeFile(npath.join(dir, 'server.pem'), 'test-only v1\n')
  await g(dir, 'add', 'server.pem')
  await g(dir, 'commit', '-q', '-m', 'pem')
  const first = await takeCheckpoint(ws(), { reason: 'prompt' })
  if (!first.rewindable) throw new Error('expected a repo')
  expect(await g(dir, 'ls-tree', '-r', '--name-only', first.checkpoint.commit)).not.toContain('server.pem')
  await fs.writeFile(npath.join(dir, 'server.pem'), 'test-only v2\n')
  await rewindWorkspace(ws(), 1)
  expect(await read(dir, 'server.pem')).toBe('test-only v2\n')
}, T)

test('rewind restores a file modified via the shell, deletes a shell-created one, without moving HEAD/branch/index', async () => {
  await fs.writeFile(npath.join(dir, 'untracked.txt'), 'keep me\n')
  const before = await repoState(dir)
  await takeCheckpoint(ws(), { reason: 'prompt' })
  await sh(dir, "printf 'shell edit\\n' > a.txt && printf 'junk\\n' > made-by-bash.txt && rm untracked.txt")
  const preview = await previewWorkspaceRewind(ws(), 1)
  if (preview === 'not_git') throw new Error('expected a repo')
  expect(preview.files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
    { status: 'M', path: 'a.txt' }, { status: 'D', path: 'made-by-bash.txt' }, { status: 'A', path: 'untracked.txt' },
  ])
  expect(preview.patch).toContain('-shell edit')

  const out = await rewindWorkspace(ws(), 1)
  expect(out).toEqual({ written: 2, deleted: 1, undoSeq: 2 })
  expect(await read(dir, 'a.txt')).toBe('one\n')
  expect(await read(dir, 'untracked.txt')).toBe('keep me\n')
  expect(await exists(dir, 'made-by-bash.txt')).toBe(false)
  expect(await repoState(dir)).toEqual(before)
  expect(events.map((e) => e.kind)).toEqual(['checkpoint.created', 'checkpoint.created', 'checkpoint.rewound'])
}, T)

test('rewind is undoable: rewinding to the undo checkpoint brings the shell edits back', async () => {
  await takeCheckpoint(ws(), { reason: 'prompt' })
  await sh(dir, "printf 'shell edit\\n' > a.txt && printf 'junk\\n' > made-by-bash.txt")
  const out = await rewindWorkspace(ws(), 1)
  if (out === 'not_git') throw new Error('expected a repo')
  await rewindWorkspace(ws(), out.undoSeq)
  expect(await read(dir, 'a.txt')).toBe('shell edit\n')
  expect(await read(dir, 'made-by-bash.txt')).toBe('junk\n')
}, T)

test('dedupe: nothing changed -> no new ref and no new event', async () => {
  const a = await takeCheckpoint(ws(), { reason: 'prompt' })
  const b = await takeCheckpoint(ws(), { reason: 'action' })
  expect(a.rewindable && b.rewindable && b.deduped && b.checkpoint.seq === a.checkpoint.seq).toBe(true)
  expect(events).toHaveLength(1)
  await fs.writeFile(npath.join(dir, 'a.txt'), 'changed\n')
  const c = await takeCheckpoint(ws(), { reason: 'prompt' })
  expect(c.rewindable && !c.deduped && c.checkpoint.seq === 2).toBe(true)
}, T)

test('retention keeps the last N per workspace and prunes older refs', async () => {
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(npath.join(dir, 'a.txt'), `v${i}\n`)
    await takeCheckpoint(ws(), { reason: 'prompt', keep: 3 })
  }
  const repo = await repoOf(dir)
  expect((await listCheckpoints(repo!, 'ws-1')).map((c) => c.seq)).toEqual([3, 4, 5])
}, T)

test('workspace in a subdirectory: only that subtree is restored', async () => {
  await fs.mkdir(npath.join(dir, 'app'))
  await fs.writeFile(npath.join(dir, 'app', 'x.txt'), 'x1\n')
  const sub = { id: 'ws-sub', cwd: npath.join(dir, 'app') }
  await takeCheckpoint(sub, { reason: 'prompt' })
  await fs.writeFile(npath.join(dir, 'app', 'x.txt'), 'x2\n')
  await fs.writeFile(npath.join(dir, 'a.txt'), 'outside\n')
  await rewindWorkspace(sub, 1)
  expect(await read(dir, 'app/x.txt')).toBe('x1\n')
  expect(await read(dir, 'a.txt')).toBe('outside\n')
}, T)

test('non-git workspace is labeled not rewindable; halt snapshots the rest', async () => {
  const plain = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-plain-')))
  try {
    const res = await takeCheckpoint({ id: 'ws-plain', cwd: plain }, { reason: 'prompt' })
    expect(res).toEqual({ rewindable: false, why: 'not_git' })
    expect(await listWorkspaceCheckpoints({ id: 'ws-plain', cwd: plain })).toEqual({ rewindable: false, why: 'not_git' })
    expect(events.at(-1)).toMatchObject({ kind: 'checkpoint.unavailable', workspaceId: 'ws-plain', payload: { why: 'not_git', rewindable: false } })
    await fs.writeFile(npath.join(dir, 'a.txt'), 'panic\n')
    await panicSnapshot([{ id: 'ws-plain', cwd: plain }, ws(), { id: 'no-cwd' }])
    const listing = await listWorkspaceCheckpoints(ws())
    expect(listing.rewindable && listing.checkpoints[0]?.reason).toBe('halt')
  } finally {
    await fs.rm(plain, { recursive: true, force: true })
  }
}, T)

test('route: list, preview, rewind, errors', async () => {
  const deps = { workspace: (id: string) => (id === 'ws-1' ? ws() : null) }
  const body = (b: unknown) => () => Promise.resolve(JSON.stringify(b))
  const none = () => Promise.resolve('')
  await takeCheckpoint(ws(), { reason: 'prompt' })
  await fs.writeFile(npath.join(dir, 'a.txt'), 'later\n')
  expect(await checkpointRoute('/api/other', 'GET', new URLSearchParams(), none, deps)).toBeNull()
  const list = await checkpointRoute(CHECKPOINTS_PATH, 'GET', new URLSearchParams({ workspace: 'ws-1' }), none, deps)
  expect(list?.status).toBe(200)
  expect((list?.body as { checkpoints: unknown[] }).checkpoints).toHaveLength(1)
  expect((await checkpointRoute(CHECKPOINTS_PATH, 'GET', new URLSearchParams({ workspace: 'nope' }), none, deps))?.status).toBe(404)
  expect((await checkpointRoute(`${CHECKPOINTS_PATH}/rewind`, 'GET', new URLSearchParams(), none, deps))?.status).toBe(405)
  expect((await checkpointRoute(`${CHECKPOINTS_PATH}/preview`, 'GET', new URLSearchParams({ workspace: 'ws-1', seq: '99' }), none, deps))?.status).toBe(404)
  expect((await checkpointRoute(`${CHECKPOINTS_PATH}/preview`, 'GET', new URLSearchParams({ workspace: 'ws-1', seq: 'x' }), none, deps))?.status).toBe(400)
  const rw = await checkpointRoute(`${CHECKPOINTS_PATH}/rewind`, 'POST', new URLSearchParams(), body({ workspace: 'ws-1', seq: 1 }), deps)
  expect(rw).toEqual({ status: 200, body: { written: 1, deleted: 0, undoSeq: 2 } })
  expect(await read(dir, 'a.txt')).toBe('one\n')
}, T)

test('hooks: Central action (R1+) and Halt checkpoint the registered workspace; R0 reads do not', async () => {
  const ledger = new Database(':memory:')
  ledger.exec('CREATE TABLE project (id TEXT PRIMARY KEY, workspace_id TEXT)')
  ledger.exec("INSERT INTO project VALUES ('p1', 'ws-1')")
  const rec = { id: 'ws-1', name: 'Repo', cwd: dir, nodes: [] }
  const unregister = registerWorkspaceLookup((id) => (id === 'ws-1' ? rec : null), () => [rec])
  try {
    await checkpointBeforeAction(ledger, 'p1', 'R0')
    expect(await listWorkspaceCheckpoints(ws())).toEqual({ rewindable: true, checkpoints: [] })
    await checkpointBeforeAction(ledger, 'p1', 'R1')
    await fs.writeFile(npath.join(dir, 'a.txt'), 'after action\n')
    await panicSnapshotAll()
    const listing = await listWorkspaceCheckpoints(ws())
    expect(listing.rewindable && listing.checkpoints.map((c) => c.reason)).toEqual(['halt', 'action'])
  } finally {
    unregister()
  }
}, T)
