// Hub watcher (`fsWatch.ts`) terhadap filesystem NYATA di $TMPDIR + seam pemantau palsu untuk jalur
// gagal. Bun-only; matcher terbatas pada yang diekspos `bun-test.d.ts` (toBe/toContain).
import { test, expect, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { createFsWatchHub, type WatchFn } from './fsWatch'
import { gitMarks, resolveGitDir } from './fsGit'

const DEBOUNCE = 100
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-watch-'))
  try { await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

// Every hub and client of a test, released after it even when an assertion threw first: a real
// watcher (FSEvents) or poll interval left behind would keep firing into the next tests.
const hubs: ReturnType<typeof createFsWatchHub>[] = []
const sends: ((m: ServerMsg) => void)[] = []
const track = <H extends ReturnType<typeof createFsWatchHub>>(hub: H): H => { hubs.push(hub); return hub }
afterEach(() => {
  for (const hub of hubs.splice(0)) for (const send of sends) hub.dropClient(send)
  sends.length = 0
})

function client(): { send: (m: ServerMsg) => void; got: string[] } {
  const got: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'fsdirty') got.push(m.dir) }
  sends.push(send)
  return { got, send }
}

test('write -> one fsdirty after the debounce; a burst collapses to a single event', async () => {
  await withDir(async (dir) => {
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE }))
    const c = client()
    hub.watch(c.send, dir)
    await sleep(50) // beri watcher waktu terpasang
    for (let i = 0; i < 10; i++) await fs.writeFile(npath.join(dir, `f${i}.txt`), 'x')
    await sleep(DEBOUNCE * 4)
    expect(c.got.length).toBe(1)
    expect(c.got[0]).toBe(dir)
    hub.dropClient(c.send)
  })
})

test('ignores .webterm-*.tmp and .git entries', async () => {
  await withDir(async (dir) => {
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE }))
    const c = client()
    hub.watch(c.send, dir)
    await sleep(50)
    await fs.writeFile(npath.join(dir, '.webterm-abc123def456.tmp'), 'x')
    await fs.mkdir(npath.join(dir, '.git'))
    await sleep(DEBOUNCE * 4)
    expect(c.got.length).toBe(0)
    await fs.writeFile(npath.join(dir, 'real.txt'), 'x')
    await sleep(DEBOUNCE * 4)
    expect(c.got.length).toBe(1)
    hub.dropClient(c.send)
  })
})

test('refcount: one watcher per dir, released only after the last client leaves; dropClient releases all', async () => {
  await withDir(async (dir) => {
    const sub = npath.join(dir, 'sub')
    await fs.mkdir(sub)
    let open = 0
    const watch: WatchFn = () => { open++; return { close: () => { open-- } } }
    const hub = track(createFsWatchHub({ watch }))
    const a = client(), b = client()
    hub.watch(a.send, dir); hub.watch(b.send, dir); hub.watch(a.send, dir)
    expect(open).toBe(1)
    expect(hub.size()).toBe(1)
    hub.unwatch(a.send, dir)
    expect(open).toBe(1)
    hub.unwatch(b.send, dir)
    expect(open).toBe(0)
    expect(hub.size()).toBe(0)

    hub.watch(a.send, dir); hub.watch(a.send, sub); hub.watch(b.send, sub)
    expect(open).toBe(2)
    hub.dropClient(a.send)
    expect(open).toBe(1) // sub masih dipegang b
    hub.dropClient(b.send)
    expect(open).toBe(0)
    expect(hub.size()).toBe(0)
  })
})

test('deleted directory: one dirty, then the watcher is released', async () => {
  await withDir(async (dir) => {
    const gone = npath.join(dir, 'gone')
    await fs.mkdir(gone)
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE, pollMs: 40 }))
    const c = client()
    hub.watch(c.send, gone)
    await sleep(50)
    await fs.rm(gone, { recursive: true })
    await sleep(DEBOUNCE * 5)
    expect(c.got.length).toBe(1)
    expect(hub.size()).toBe(0)
  })
})

test('EMFILE on open falls back to polling and still reports a new entry', async () => {
  await withDir(async (dir) => {
    const watch: WatchFn = () => { throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }) }
    const hub = track(createFsWatchHub({ watch, debounceMs: DEBOUNCE, pollMs: 30 }))
    const c = client()
    hub.watch(c.send, dir)
    expect(hub.size()).toBe(1)
    await sleep(60) // snapshot awal
    await fs.writeFile(npath.join(dir, 'new.txt'), 'x')
    await sleep(30 + DEBOUNCE + 100)
    expect(c.got.length).toBe(1)
    hub.dropClient(c.send)
    expect(hub.size()).toBe(0)
  })
})

test('watcher error after start switches to polling and flushes; other open errors are ignored', async () => {
  await withDir(async (dir) => {
    let fail: (e: Error) => void = () => {}
    let closed = 0
    const watch: WatchFn = (_d, _ev, onError) => { fail = onError; return { close: () => { closed++ } } }
    const hub = track(createFsWatchHub({ watch, debounceMs: DEBOUNCE, pollMs: 30 }))
    const c = client()
    hub.watch(c.send, dir)
    fail(Object.assign(new Error('boom'), { code: 'EIO' }))
    await sleep(DEBOUNCE * 4)
    expect(closed).toBe(1)
    expect(c.got.length).toBe(1)
    hub.dropClient(c.send)

    const denied: WatchFn = () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }) }
    const hub2 = track(createFsWatchHub({ watch: denied }))
    hub2.watch(c.send, dir)
    expect(hub2.size()).toBe(0)
  })
})

test('cap on watched directories and invalid paths are ignored', async () => {
  await withDir(async (dir) => {
    const a = npath.join(dir, 'a'), b = npath.join(dir, 'b')
    await fs.mkdir(a); await fs.mkdir(b)
    const hub = track(createFsWatchHub({ watch: () => ({ close() {} }), max: 1 }))
    const c = client()
    hub.watch(c.send, a)
    hub.watch(c.send, b)
    hub.watch(c.send, 'relative/path')
    hub.watch(c.send, `${dir}/x\0y`)
    expect(hub.size()).toBe(1)
    hub.dropClient(c.send)
  })
})

const REPO = { gitDir: '/repo/.git', commonDir: '/repo/.git' }

test('git watchers: one gitdir + one recursive refs per repo, shared by its dirs and worktrees, counted against max, closed with the last dir', async () => {
  await withDir(async (dir) => {
    const a = npath.join(dir, 'a'), b = npath.join(dir, 'b'), wt = npath.join(dir, 'wt'), other = npath.join(dir, 'other')
    for (const d of [a, b, wt, other]) await fs.mkdir(d)
    const opened: string[] = []
    const watch: WatchFn = (d, _ev, _err, rec) => { opened.push(`${d}${rec ? ' -r' : ''}`); return { close: () => { opened.splice(opened.indexOf(`${d}${rec ? ' -r' : ''}`), 1) } } }
    const gitDir = async (d: string) => (d === other ? null : d === wt ? { gitDir: '/repo/.git/worktrees/wt', commonDir: '/repo/.git' } : REPO)
    const hub = track(createFsWatchHub({ watch, gitDir, max: 6 }))
    const c = client()
    hub.watch(c.send, a); hub.watch(c.send, b)
    await sleep(10)
    expect(hub.gitSize()).toBe(2)
    expect(opened.filter((d) => d.startsWith('/repo')).sort().join('|')).toBe('/repo/.git|/repo/.git/refs -r')
    hub.watch(c.send, wt) // own gitdir, shares the main repo's refs watcher
    await sleep(10)
    expect(hub.gitSize()).toBe(3)
    hub.watch(c.send, other) // 3 dirs + 3 git watchers = max: refused
    expect(hub.size()).toBe(3)
    hub.unwatch(c.send, wt)
    expect(hub.gitSize()).toBe(2)
    hub.unwatch(c.send, a)
    expect(hub.gitSize()).toBe(2)
    hub.unwatch(c.send, b)
    expect(hub.gitSize()).toBe(0)
    expect(opened.length).toBe(0)
  })
})

test('git events: only gitdir state files and any refs change mark every dir of the repo dirty', async () => {
  await withDir(async (dir) => {
    const a = npath.join(dir, 'a'), b = npath.join(dir, 'b')
    await fs.mkdir(a); await fs.mkdir(b)
    const fire: Record<string, (name: string | null) => void> = {}
    const watch: WatchFn = (d, onEvent) => { fire[d] = onEvent; return { close() {} } }
    const hub = track(createFsWatchHub({ watch, gitDir: async () => REPO, debounceMs: DEBOUNCE }))
    const c = client()
    hub.watch(c.send, a); hub.watch(c.send, b)
    await sleep(10)
    fire['/repo/.git']('objects'); fire['/repo/.git']('index.lock'); fire['/repo/.git']('logs')
    await sleep(DEBOUNCE * 3)
    expect(c.got.length).toBe(0)
    for (const n of ['index', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs']) {
      c.got.length = 0
      fire['/repo/.git'](n)
      await sleep(DEBOUNCE * 2)
      expect(`${n}:${c.got.sort().join('|')}`).toBe(`${n}:${[a, b].sort().join('|')}`)
    }
    c.got.length = 0
    fire['/repo/.git/refs']('remotes/origin/main')
    await sleep(DEBOUNCE * 2)
    expect(c.got.length).toBe(2)
  })
})

const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString()

test('real repo: our git status never dirties (no loop); a commit does, and the M mark disappears', async () => {
  await withDir(async (raw) => {
    const dir = realpathSync(raw)
    gitIn(dir, 'init', '-q'); await fs.writeFile(npath.join(dir, 'a.txt'), '1'); gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-qm', 'one')
    await fs.writeFile(npath.join(dir, 'a.txt'), '2')
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE, gitDir: resolveGitDir }))
    const c = client()
    hub.watch(c.send, dir)
    await sleep(300) // gitdir lookup + watchers armed; the write above is settled
    c.got.length = 0
    const marks = async () => { const r = await gitMarks(dir); if (!r.ok) throw new Error(r.error); return r.marks }
    for (let i = 0; i < 3; i++) expect((await marks())['a.txt']).toBe('M')
    await sleep(DEBOUNCE * 4)
    expect(c.got.length).toBe(0)
    expect(hub.gitSize()).toBe(2) // gitdir + refs
    gitIn(dir, 'commit', '-qam', 'two')
    await sleep(DEBOUNCE * 4)
    expect(c.got.length > 0).toBe(true)
    expect((await marks())['a.txt']).toBe(undefined)
    hub.dropClient(c.send)
    expect(hub.gitSize()).toBe(0)
  })
})

test('real linked worktree (.git is a file): commit inside it dirties the watched worktree dir', async () => {
  await withDir(async (raw) => {
    const main = npath.join(realpathSync(raw), 'main'), wt = npath.join(realpathSync(raw), 'wt')
    await fs.mkdir(main)
    gitIn(main, 'init', '-q'); await fs.writeFile(npath.join(main, 'a.txt'), '1'); gitIn(main, 'add', '-A'); gitIn(main, 'commit', '-qm', 'one')
    gitIn(main, 'worktree', 'add', '-q', wt)
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE, gitDir: resolveGitDir }))
    const c = client()
    hub.watch(c.send, wt)
    await sleep(300)
    c.got.length = 0
    await fs.writeFile(npath.join(wt, 'a.txt'), '2')
    gitIn(wt, 'add', 'a.txt')
    await sleep(DEBOUNCE * 4)
    c.got.length = 0 // the write itself dirtied the dir; what follows only touches the worktree gitdir
    gitIn(wt, 'commit', '-qm', 'two')
    await sleep(DEBOUNCE * 4)
    expect(c.got[0]).toBe(wt)
  })
})

/** Repo `work` cloned from a bare `origin`, plus a second clone `peer` that can push behind its back. */
async function withOrigin(fn: (p: { work: string; peer: string; git: typeof gitIn }) => Promise<void>): Promise<void> {
  await withDir(async (raw) => {
    const root = realpathSync(raw), origin = npath.join(root, 'origin.git'), work = npath.join(root, 'work'), peer = npath.join(root, 'peer')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    gitIn(root, 'clone', '-q', origin, work)
    await fs.writeFile(npath.join(work, 'a.txt'), '1'); gitIn(work, 'add', '-A'); gitIn(work, 'commit', '-qm', 'one'); gitIn(work, 'push', '-q', '-u', 'origin', 'main')
    gitIn(root, 'clone', '-q', origin, peer)
    await fn({ work, peer, git: gitIn })
  })
}

test('real origin: empty commit, push and fetch each dirty via refs/FETCH_HEAD and the footer counts follow', async () => {
  await withOrigin(async ({ work, peer, git }) => {
    const hub = track(createFsWatchHub({ debounceMs: DEBOUNCE, gitDir: resolveGitDir }))
    const c = client()
    hub.watch(c.send, work)
    await sleep(300)
    const branch = async () => { const r = await gitMarks(work); if (!r.ok) throw new Error(r.error); return r.branch }
    const step = async (label: string, run: () => void) => {
      c.got.length = 0
      run()
      await sleep(DEBOUNCE * 4)
      expect(`${label}:${c.got.length > 0}`).toBe(`${label}:true`)
    }
    await step('empty commit', () => git(work, 'commit', '-q', '--allow-empty', '-m', 'empty'))
    expect((await branch())?.ahead).toBe(1)
    c.got.length = 0
    await branch(); await sleep(DEBOUNCE * 4)
    expect(c.got.length).toBe(0) // our own status run still does not loop
    await step('push', () => git(work, 'push', '-q'))
    expect((await branch())?.ahead).toBe(0)
    git(peer, 'pull', '-q'); git(peer, 'commit', '-q', '--allow-empty', '-m', 'remote'); git(peer, 'push', '-q')
    await step('fetch', () => git(work, 'fetch', '-q'))
    expect((await branch())?.behind).toBe(1)
    hub.dropClient(c.send)
    expect(hub.gitSize()).toBe(0)
    expect(hub.size()).toBe(0)
  })
}, 20_000) // ~12 real git runs + debounce windows exceed bun's 5s default
