import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { BIN_CANDIDATES, chromiumCandidates, createChromiumPool, detectChromium, LaunchError, launchChromium, resolveBinary } from './chromium.launch'
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
  stderrWrite(s: string) { for (const d of this.data) d(s) }
}

const noSleep = async () => undefined
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-launch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// test-only: disk palsu = himpunan path yang "ada" + isi direktori palsu.
const fakeFs = (files: string[], dirs: Record<string, string[]> = {}) => ({
  exists: (p: string) => files.includes(p),
  listDir: (d: string) => dirs[d] ?? [],
})
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const PW = '/home/u/.cache/ms-playwright'

describe('chromiumCandidates', () => {
  it('lists only paths on disk, priority: well-known -> PATH -> Playwright (newest revision first)', () => {
    const files = [BRAVE, CHROME, '/opt/bin/chromium',
      `${PW}/chromium-1100/chrome-linux/chrome`, `${PW}/chromium-1200/chrome-linux64/chrome`]
    const fs = fakeFs(files, { [PW]: ['chromium-1100', 'chromium-1200', 'chromium_headless_shell-1200', 'ffmpeg-1'] })
    expect(chromiumCandidates({ PATH: '/opt/bin:/missing', HOME: '/home/u' }, fs.exists, fs.listDir)).toEqual([
      CHROME, BRAVE, '/opt/bin/chromium', `${PW}/chromium-1200/chrome-linux64/chrome`, `${PW}/chromium-1100/chrome-linux/chrome`,
    ])
  })
  it('dedupes a PATH hit that is also a well-known location', () => {
    const fs = fakeFs(['/usr/bin/chromium'])
    expect(chromiumCandidates({ PATH: '/usr/bin' }, fs.exists, fs.listDir)).toEqual(['/usr/bin/chromium'])
  })
  it('empty when nothing exists, and without HOME skips the Playwright cache', () => {
    const listDir = (d: string) => { throw new Error(`unexpected listDir ${d}`) }
    expect(chromiumCandidates({}, () => false, listDir)).toEqual([])
  })
})

describe('detectChromium with candidates', () => {
  const fs = fakeFs(['/opt/bin/chromium', '/opt/custom'])
  const env = { PATH: '/opt/bin' }
  it('valid override wins over auto candidates', () => {
    expect(detectChromium({ ...env, [ENV_BROWSER.bin]: '/opt/custom' }, fs.exists, fs.listDir)).toEqual({ path: '/opt/custom', source: 'override' })
  })
  it('invalid override does NOT fall back to auto (existing contract)', () => {
    expect(detectChromium({ ...env, [ENV_BROWSER.bin]: '/opt/gone' }, fs.exists, fs.listDir)).toBeNull()
  })
  it('empty/blank override = auto, first candidate', () => {
    expect(detectChromium({ ...env, [ENV_BROWSER.bin]: '  ' }, fs.exists, fs.listDir)).toEqual({ path: '/opt/bin/chromium', source: 'auto' })
  })
})

describe('resolveBinary', () => {
  it('prefers the explicit env path when it exists', () => {
    expect(resolveBinary({ [ENV_BROWSER.bin]: '/opt/c' }, (p) => p === '/opt/c')).toBe('/opt/c')
  })
  it('does not silently fall back when the explicit path is missing', () => {
    expect(() => resolveBinary({ [ENV_BROWSER.bin]: '/opt/missing' }, () => false)).toThrow(LaunchError)
  })
  it('falls back to the first existing candidate', () => {
    expect(resolveBinary({}, (p) => p === BIN_CANDIDATES[3])).toBe(BIN_CANDIDATES[3])
  })
  it('throws no_binary when nothing is found', () => {
    expect(() => resolveBinary({}, () => false)).toThrowError(expect.objectContaining({ code: 'no_binary' }))
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
  function pool() {
    const children: FakeChild[] = []
    const spawned: string[][] = []
    const p = createChromiumPool({
      env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => true,
      deps: {
        spawn: (_b, args) => { const c = new FakeChild(); children.push(c); spawned.push(args); return c },
        readFile: () => `${1000 + children.length}\n/devtools/browser/x`,
        sleep: noSleep,
      },
    })
    return { p, children, spawned }
  }

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
    const p = createChromiumPool({ env: {}, dataRoot: dir, proxyServer: () => 'http://127.0.0.1:9', exists: () => false })
    await expect(p.acquire('wa')).rejects.toMatchObject({ code: 'no_binary' })
  })
})
