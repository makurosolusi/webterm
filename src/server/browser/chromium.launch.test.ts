import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { chromiumCandidates, createChromiumPool, detectChromium, LaunchError, launchChromium, launchReason, managedPathOf, resolveBinary } from './chromium.launch'
import type { ChildLike, LaunchDeps } from './chromium.launch'

class FakeChild implements ChildLike {
  pid = 4242
  signals: string[] = []
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  private data: Array<(b: string) => void> = []
  stderr = { on: (_ev: 'data', cb: (b: Buffer | string) => void) => { this.data.push(cb as (b: string) => void) } }
  once(ev: 'exit' | 'error', cb: (...a: unknown[]) => void) { (this.handlers[ev] ??= []).push(cb) }
  kill(sig?: NodeJS.Signals) { this.signals.push(sig ?? 'SIGTERM'); return true }
  exit() { for (const h of this.handlers.exit ?? []) h(1) }
  fail(e: Error) { for (const h of this.handlers.error ?? []) h(e) }
  stderrWrite(s: string) { for (const d of this.data) d(s) }
}

const noSleep = async () => undefined
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-launch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const MANAGED = managedPathOf({ WEBTERM_DATA_DIR: '/d' }) as string

describe('managed-only resolution', () => {
  it('lists only the managed binary, and only when it exists; installed browsers are never candidates', () => {
    const env = { WEBTERM_DATA_DIR: '/d', PATH: '/usr/bin', HOME: '/home/u' }
    const installed = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
    expect(chromiumCandidates(env, (p) => installed.includes(p))).toEqual([])
    expect(chromiumCandidates(env, (p) => p === MANAGED || installed.includes(p))).toEqual([MANAGED])
  })
  it('default data dir under HOME like config.ts', () => {
    expect(managedPathOf({ HOME: '/home/u' })).toContain('/home/u/.webterm-server/browser/chrome-for-testing/')
    expect(managedPathOf({})).toBeNull()
  })
  it('detectChromium: valid override wins; invalid override does NOT fall back', () => {
    expect(detectChromium({ [ENV_BROWSER.bin]: '/opt/c' }, () => true)).toEqual({ path: '/opt/c', source: 'override' })
    expect(detectChromium({ [ENV_BROWSER.bin]: '/opt/c', WEBTERM_DATA_DIR: '/d' }, (p) => p === MANAGED)).toBeNull()
  })
  it('detectChromium: blank override = managed path (even before the first download)', () => {
    expect(detectChromium({ [ENV_BROWSER.bin]: '  ', WEBTERM_DATA_DIR: '/d' }, () => false)).toEqual({ path: MANAGED, source: 'auto' })
  })
  it('resolveBinary: explicit, then managed, else no_binary (never an installed browser)', () => {
    expect(resolveBinary({ [ENV_BROWSER.bin]: '/opt/c' }, () => true)).toBe('/opt/c')
    expect(() => resolveBinary({ [ENV_BROWSER.bin]: '/opt/c' }, () => false)).toThrow(LaunchError)
    expect(resolveBinary({ WEBTERM_DATA_DIR: '/d' }, (p) => p === MANAGED)).toBe(MANAGED)
    expect(() => resolveBinary({ WEBTERM_DATA_DIR: '/d' }, (p) => p === '/usr/bin/chromium')).toThrow(/not downloaded/)
  })
})

describe('launchChromium', () => {
  const opts = () => ({ bin: '/bin/chrome', profileDir: join(dir, 'p'), proxyServer: 'http://127.0.0.1:9' })

  it('spawns with the safe args and returns the ws url from DevToolsActivePort', async () => {
    const child = new FakeChild()
    let seen: { bin: string; args: string[] } | undefined
    let reads = 0
    const deps: LaunchDeps = {
      spawn: (bin, args) => { seen = { bin, args }; return child },
      readFile: () => (++reads < 3 ? null : '51234\n/devtools/browser/abc-def\n'),
      sleep: noSleep,
    }
    const l = await launchChromium(opts(), deps)
    expect(l.wsUrl).toBe('ws://127.0.0.1:51234/devtools/browser/abc-def')
    expect(seen?.bin).toBe('/bin/chrome')
    expect(seen?.args).toContain(`--user-data-dir=${join(dir, 'p')}`)
    expect(seen?.args.join(' ')).not.toContain('no-sandbox')
    l.kill()
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('reports sandbox_unavailable (no auto --no-sandbox) when it exits mentioning the sandbox', async () => {
    const child = new FakeChild()
    const deps: LaunchDeps = { spawn: () => { queueMicrotask(() => { child.stderrWrite('FATAL: No usable sandbox!'); child.exit() }); return child }, readFile: () => null, sleep: async () => { await Promise.resolve() } }
    await expect(launchChromium(opts(), deps)).rejects.toMatchObject({ code: 'sandbox_unavailable' })
  })

  it('reports launch_failed when the process exits before DevTools is ready', async () => {
    const child = new FakeChild()
    const deps: LaunchDeps = { spawn: () => { queueMicrotask(() => child.exit()); return child }, readFile: () => null, sleep: async () => { await Promise.resolve() } }
    await expect(launchChromium(opts(), deps)).rejects.toMatchObject({ code: 'launch_failed' })
  })

  it('names the specific cause of a failed launch (log + UI): crashed_on_start, debug_port_timeout, spawn_error', async () => {
    const exits = new FakeChild()
    const early: LaunchDeps = { spawn: () => { queueMicrotask(() => exits.exit()); return exits }, readFile: () => null, sleep: async () => { await Promise.resolve() } }
    const e1 = await launchChromium(opts(), early).catch((e: unknown) => e)
    expect(launchReason(e1)).toBe('crashed_on_start')
    const hang = new FakeChild()
    const e2 = await launchChromium(opts(), { spawn: () => hang, readFile: () => null, sleep: () => new Promise((r) => setTimeout(r, 5)), startTimeoutMs: 20 }).catch((e: unknown) => e)
    expect(launchReason(e2)).toBe('debug_port_timeout')
    const broken = new FakeChild()
    const e3 = await launchChromium(opts(), { spawn: () => { queueMicrotask(() => broken.fail(new Error('ENOENT'))); return broken }, readFile: () => null, sleep: async () => { await Promise.resolve() } }).catch((e: unknown) => e)
    expect(launchReason(e3)).toBe('spawn_error')
    expect(launchReason(new LaunchError('profile_locked', 'held'))).toBe('profile_locked')
    expect(launchReason(new LaunchError('no_binary', 'none'))).toBe('bin_not_found')
    expect(launchReason(new Error('ws refused'))).toBe('connect_failed')
  })

  it('kills the child and fails when the port file never appears', async () => {
    const child = new FakeChild()
    const deps: LaunchDeps = { spawn: () => child, readFile: () => null, sleep: noSleep, startTimeoutMs: 20 }
    await expect(launchChromium(opts(), { ...deps, sleep: () => new Promise((r) => setTimeout(r, 5)) })).rejects.toThrow(/did not publish DevToolsActivePort/)
    expect(child.signals[0]).toBe('SIGTERM')
  })

  it('ignores a malformed port file', async () => {
    const child = new FakeChild()
    const files = ['garbage', '12x\n/p', '777\n/devtools/browser/ok']
    const deps: LaunchDeps = { spawn: () => child, readFile: () => files.shift() ?? null, sleep: noSleep }
    expect((await launchChromium(opts(), deps)).wsUrl).toBe('ws://127.0.0.1:777/devtools/browser/ok')
  })
})

describe('createChromiumPool', () => {
  function pool(env: Record<string, string> = {}, platform: NodeJS.Platform = 'darwin') {
    const children: FakeChild[] = []
    const spawned: string[][] = []
    const p = createChromiumPool({
      env: { WEBTERM_DATA_DIR: dir, ...env }, platform, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
      deps: {
        spawn: (_b, args) => { const c = new FakeChild(); children.push(c); spawned.push(args); return c },
        readFile: () => `${1000 + children.length}\n/devtools/browser/x`,
        sleep: noSleep,
      },
    })
    return { p, children, spawned }
  }

  it('launches headful off-screen by default; headless only when forced or Linux has no display', async () => {
    const run = async (env: Record<string, string>, platform: NodeJS.Platform) => {
      const { p, spawned } = pool(env, platform)
      await p.acquire('wa')
      return spawned[0]
    }
    expect(await run({}, 'darwin')).not.toContain('--headless=new')
    expect(await run({}, 'darwin')).toContain('--window-position=-32000,-32000')
    expect(await run({ [ENV_BROWSER.headless]: 'on' }, 'darwin')).toContain('--headless=new')
    expect(await run({}, 'linux')).toContain('--headless=new')
    expect(await run({ DISPLAY: ':0' }, 'linux')).not.toContain('--headless=new')
  })

  it('starts one process per workspace and reuses it', async () => {
    const { p, children, spawned } = pool()
    const [a1, a2] = await Promise.all([p.acquire('wa'), p.acquire('wa')])
    const b = await p.acquire('wb')
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
    expect(children).toHaveLength(2)
    expect(spawned[0].find((a) => a.startsWith('--user-data-dir='))).toContain(join('browser', 'profiles', 'wa'))
  })

  it('relaunches after the process exits', async () => {
    const { p, children } = pool()
    await p.acquire('wa')
    children[0].exit()
    await p.acquire('wa')
    expect(children).toHaveLength(2)
  })

  it('shutdown kills every process', async () => {
    const { p, children } = pool()
    await p.acquire('wa')
    await p.acquire('wb')
    p.shutdown()
    await Promise.resolve()
    expect(children.map((c) => c.signals[0])).toEqual(['SIGTERM', 'SIGTERM'])
  })

  it('rejects an unsafe workspace id and does not cache the failure', async () => {
    const { p, children } = pool()
    await expect(p.acquire('../evil')).rejects.toThrow(/unsafe/)
    expect(children).toHaveLength(0)
  })

  it('surfaces no_binary from resolution', async () => {
    const p = createChromiumPool({ env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => false, install: async () => { throw new Error('offline') } })
    await expect(p.acquire('wa')).rejects.toMatchObject({ code: 'no_binary' })
  })

  it('downloads the managed build once when missing (zero-config), then launches it', async () => {
    const installed: string[] = []
    const children: string[] = []
    const p = createChromiumPool({
      env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => false, platform: 'linux',
      install: async (root) => { installed.push(root); return '/managed/chrome' },
      deps: { spawn: (bin) => { children.push(bin); return new FakeChild() }, readFile: () => '9222\n/devtools/browser/x', sleep: noSleep },
    })
    await p.acquire('wa')
    expect(installed).toEqual([join(dir, 'browser', 'chrome-for-testing')])
    expect(children).toEqual(['/managed/chrome'])
  })

  it('does not download when WEBTERM_BROWSER_BIN is set but missing', async () => {
    let called = false
    const p = createChromiumPool({ env: { [ENV_BROWSER.bin]: '/gone' }, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => false, install: async () => { called = true; return 'x' } })
    await expect(p.acquire('wa')).rejects.toMatchObject({ code: 'no_binary' })
    expect(called).toBe(false)
  })
})
