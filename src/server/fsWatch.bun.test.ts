// Hub watcher (`fsWatch.ts`) terhadap filesystem NYATA di $TMPDIR + seam pemantau palsu untuk jalur
// gagal. Bun-only; matcher terbatas pada yang diekspos `bun-test.d.ts` (toBe/toContain).
import { test, expect, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { createFsWatchHub, type WatchFn } from './fsWatch'

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
