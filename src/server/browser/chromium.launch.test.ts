import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { BIN_CANDIDATES, createChromiumPool, LaunchError, launchChromium, resolveBinary } from './chromium.launch'
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
