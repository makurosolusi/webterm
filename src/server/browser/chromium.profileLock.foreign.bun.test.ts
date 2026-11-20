// Foreign-host profile lock (container recreated on the same /data volume): cleared before launch, nothing else touched.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearForeignLock, SINGLETON_LOCK } from './chromium.profileLock'
import { createChromiumPool } from './chromium.launch'
import type { ChildLike } from './chromium.launch'
import { profileDirFor } from './chromium.flags'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-flock-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const present = (d: string, f: string) => { try { lstatSync(join(d, f)); return true } catch { return false } }
const thrown = (fn: () => void): string => { try { fn() } catch (e) { return (e as Error).message } return 'no throw' }

describe('clearForeignLock (fake deps)', () => {
  const run = (target: string | null, host = 'me') => {
    const removed: string[] = []
    const r = clearForeignLock(dir, { readLock: () => target, hostname: () => host, unlink: (p) => { removed.push(p) } })
    return { r, removed }
  }
  it('removes exactly the three lock files for another host', () => {
    const { r, removed } = run('43ec2ef06527-777')
    expect(r).toBe(true)
    expect(removed).toEqual([join(dir, 'SingletonLock'), join(dir, 'SingletonSocket'), join(dir, 'SingletonCookie')])
  })
  it('keeps a same-host lock (live holder is reclaimProfile; dead pid is Chromium own business)', () => {
    const { r, removed } = run('me-777')
    expect(removed).toEqual([])
    expect(r).toBe(false)
  })
  it('is a no-op without a lock or with an unrecognised target', () => {
    expect(run(null).removed).toEqual([])
    expect(run('weird').removed).toEqual([])
  })
  it('propagates a permission error', () => {
    expect(thrown(() => clearForeignLock(dir, { readLock: () => 'other-1', hostname: () => 'me', unlink: () => { throw new Error('EACCES') } }))).toBe('EACCES')
  })
})

describe('real files', () => {
  it('unlinks a fakehost-123 lock and siblings, leaves the rest, never follows symlinks', () => {
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'keep')
    const profile = join(dir, 'p'); mkdirSync(profile)
    symlinkSync('fakehost-123', join(profile, SINGLETON_LOCK))
    symlinkSync(outside, join(profile, 'SingletonSocket')) // suspicious: points outside the profile
    symlinkSync('x', join(profile, 'SingletonCookie'))
    writeFileSync(join(profile, 'Cookies'), 'db')
    expect(clearForeignLock(profile, { hostname: () => 'realhost' })).toBe(true)
    for (const f of [SINGLETON_LOCK, 'SingletonSocket', 'SingletonCookie']) expect(present(profile, f)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(readFileSync(join(profile, 'Cookies'), 'utf8')).toBe('db')
  })
  it('reports an unremovable file with context', () => {
    const profile = join(dir, 'p'); mkdirSync(profile)
    symlinkSync('fakehost-123', join(profile, SINGLETON_LOCK))
    mkdirSync(join(profile, 'SingletonSocket')) // unlink on a directory fails
    expect(thrown(() => clearForeignLock(profile, { hostname: () => 'realhost' }))).toContain('cannot remove stale Chromium profile lock file')
  })
})

class FakeChild implements ChildLike {
  pid = 1
  stderr = { on: () => undefined }
  once() { /* never exits */ }
  kill() { return true }
}

describe('pool acquire', () => {
  it('clears a foreign lock before spawning, and still launches', async () => {
    const pd = profileDirFor(dir, 'wa'); mkdirSync(pd, { recursive: true })
    symlinkSync('43ec2ef06527-777', join(pd, SINGLETON_LOCK))
    let lockAtSpawn: boolean | null = null
    const p = createChromiumPool({
      env: { WEBTERM_DATA_DIR: '/d' }, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
      deps: {
        hostname: () => 'newhost',
        spawn: () => { lockAtSpawn = present(pd, SINGLETON_LOCK); return new FakeChild() },
        readFile: (f) => (f.endsWith('DevToolsActivePort') ? '9222\n/devtools/browser/x' : null),
      },
    })
    expect(await p.acquire('wa')).toBe('ws://127.0.0.1:9222/devtools/browser/x')
    expect(lockAtSpawn).toBe(false)
  })
})
