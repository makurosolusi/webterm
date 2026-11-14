// Stale profile owner: a leftover Chromium that still holds `<profile>/SingletonLock` is reclaimed before a launch,
// but only when its command line proves it is ours for that exact profile. Every process probe is a fake.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChromiumPool, launchChromium } from './chromium.launch'
import type { ChildLike, LaunchDeps } from './chromium.launch'
import { ownsProfile, SINGLETON_LOCK } from './chromium.profileLock'
import { profileDirFor } from './chromium.flags'

class FakeChild implements ChildLike {
  pid = 4242
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  stderr = { on: () => undefined }
  once(ev: 'exit' | 'error', cb: (...a: unknown[]) => void) { (this.handlers[ev] ??= []).push(cb) }
  kill() { return true }
  exit() { for (const h of this.handlers.exit ?? []) h(1) }
}

const STALE = 777 // test-only pid
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-lock-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Fake process table: `alive` pids, their command lines, and the signals sent (a TERM ends the pid unless `stubborn`). */
function procs(o: { lock?: string | null; command?: string | null; alive?: boolean; stubborn?: boolean; staysAfterKill?: boolean }) {
  const live = new Set(o.alive === false ? [] : [STALE])
  const signals: string[] = []
  const deps: LaunchDeps = {
    readLock: (p) => (p.endsWith(SINGLETON_LOCK) ? (o.lock === undefined ? `host-${STALE}` : o.lock) : null),
    commandOf: async (pid) => (live.has(pid) ? (o.command ?? null) : null),
    alive: (pid) => live.has(pid),
    signal: (pid, sig) => {
      signals.push(sig)
      if ((sig === 'SIGTERM' && !o.stubborn) || (sig === 'SIGKILL' && !o.staysAfterKill)) live.delete(pid)
    },
    sleep: async () => undefined,
  }
  return { deps, signals, live }
}

function pool(deps: LaunchDeps) {
  const children: FakeChild[] = []
  const p = createChromiumPool({
    env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
    deps: {
      ...deps,
      spawn: () => { const c = new FakeChild(); children.push(c); return c },
      readFile: (f) => (f.endsWith('DevToolsActivePort') ? '9222\n/devtools/browser/x' : null),
    },
  })
  return { p, children }
}

const ours = () => `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDirFor(dir, 'wa')} --remote-debugging-port=0`

describe('stale profile reclaim on acquire', () => {
  it('kills a live Chromium for this exact profile (TERM), then launches', async () => {
    const f = procs({ command: ours() })
    const { p, children } = pool(f.deps)
    expect(await p.acquire('wa')).toBe('ws://127.0.0.1:9222/devtools/browser/x')
    expect(f.signals).toEqual(['SIGTERM'])
    expect(children).toHaveLength(1)
  })

  it('escalates to SIGKILL when TERM is ignored for the grace period', async () => {
    const f = procs({ command: ours(), stubborn: true })
    await pool(f.deps).p.acquire('wa')
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(f.live.size).toBe(0)
  })

  it('never kills a pid whose command line is another profile (or a longer sibling path)', async () => {
    for (const command of [`chrome --user-data-dir=${dir}/other`, `chrome --user-data-dir=${profileDirFor(dir, 'wa')}-copy`, 'vim notes.txt']) {
      const f = procs({ command })
      await pool(f.deps).p.acquire('wa')
      expect(f.signals).toEqual([])
    }
  })

  it('no kill when the lock holder is dead, or there is no lock at all', async () => {
    for (const f of [procs({ command: ours(), alive: false }), procs({ command: ours(), lock: null }), procs({ command: ours(), lock: 'garbage' })]) {
      await pool(f.deps).p.acquire('wa')
      expect(f.signals).toEqual([])
    }
  })

  it('ownsProfile matches the flag exactly', () => {
    expect(ownsProfile('c --user-data-dir=/a/b', '/a/b')).toBe(true)
    expect(ownsProfile('c --user-data-dir=/a/b --x', '/a/b')).toBe(true)
    expect(ownsProfile('c --user-data-dir=/a/bc', '/a/b')).toBe(false)
  })
})

describe('profile_locked', () => {
  it('a lock still held after reclaim -> LaunchError profile_locked, not a generic launch_failed', async () => {
    const f = procs({ command: ours(), stubborn: true, staysAfterKill: true })
    const child = new FakeChild()
    // Through the pool: the holder survives TERM and KILL, Chromium hands off to it and exits.
    const pooled = createChromiumPool({
      env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
      deps: { ...f.deps, spawn: () => { queueMicrotask(() => child.exit()); return child }, readFile: () => null, sleep: async () => { await Promise.resolve() } },
    })
    expect(await pooled.acquire('wa').catch((e: unknown) => e)).toMatchObject({ code: 'profile_locked' })
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('an exit with no live lock holder stays launch_failed', async () => {
    const f = procs({ alive: false })
    const child = new FakeChild()
    const deps: LaunchDeps = { ...f.deps, spawn: () => { queueMicrotask(() => child.exit()); return child }, readFile: () => null, sleep: async () => { await Promise.resolve() } }
    const err = await launchChromium({ bin: '/bin/chrome', profileDir: join(dir, 'p'), proxyServer: 'http://127.0.0.1:9' }, deps).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'launch_failed' })
  })
})
