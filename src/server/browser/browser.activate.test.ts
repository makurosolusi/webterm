// Tes hidup-mati runtime browser (ES-08): CDP + peluncur TIRUAN, tanpa Chromium nyata.
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { CapabilityStore } from '../control/capabilities'
import { createFileSecretStore } from '../envSecrets.store'
import { reconcile } from '../featureCapabilities.runtime'
import { activeBrowser, registerBrowserCapability, startBrowser, stopBrowser } from './browser.activate'
import type { RuntimeDeps } from './browser.runtime'
import { setActiveBrowser } from './browser.state'
import { detectChromium } from './chromium.launch'
import { startFakeCdp } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

const WS: Workspace = {
  id: 'w1', name: 'w', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'b1', kind: 'browser', x: 0, y: 0, url: 'https://example.com/' }],
}
const ON = { [ENV_BROWSER.enabled]: 'on' }
let dir: string
let fake: FakeCdp
let acquires: number
const cleanup: Array<() => Promise<void> | void> = []

const deps = (over: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  env: ON, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')),
  capabilities: new CapabilityStore(), workspaces: () => [WS],
  launcher: { acquire: async () => { acquires++; return fake.url }, shutdown: () => undefined },
  ...over,
})
const until = async (cond: () => boolean) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true) }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wt-bract-'))
  fake = await startFakeCdp()
  acquires = 0
  setActiveBrowser(null)
})
afterEach(async () => {
  await stopBrowser()
  for (const c of cleanup.splice(0).reverse()) await c()
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('startBrowser / stopBrowser', () => {
  it('start dua kali memakai satu instans', async () => {
    await startBrowser(deps())
    const first = activeBrowser()
    expect(first).not.toBeNull()
    await Promise.all([startBrowser(deps()), startBrowser(deps())])
    expect(activeBrowser()).toBe(first)
  })

  it('start bersamaan sebelum selesai tetap satu instans', async () => {
    await Promise.all([startBrowser(deps()), startBrowser(deps())])
    expect(activeBrowser()).not.toBeNull()
  })

  it('stop dua kali tidak melempar dan mengosongkan runtime', async () => {
    await startBrowser(deps())
    await stopBrowser()
    expect(activeBrowser()).toBeNull()
    await expect(stopBrowser()).resolves.toBeUndefined()
  })

  it('start;stop;start menghasilkan instans baru', async () => {
    await startBrowser(deps())
    const first = activeBrowser()
    await stopBrowser()
    await startBrowser(deps())
    expect(activeBrowser()).not.toBeNull()
    expect(activeBrowser()).not.toBe(first)
  })

  it('stop sebelum start tidak melempar', async () => {
    await expect(stopBrowser()).resolves.toBeUndefined()
    expect(activeBrowser()).toBeNull()
  })

  it('stop lalu start langsung (tanpa menunggu) tetap berakhir hidup', async () => {
    await startBrowser(deps())
    const stopped = stopBrowser()
    await startBrowser(deps())
    await stopped
    expect(activeBrowser()).not.toBeNull()
  })

  it('kemampuan off di env = tidak ada runtime', async () => {
    await startBrowser(deps({ env: {} }))
    expect(activeBrowser()).toBeNull()
  })

  it('Chromium hilang: tidak melempar, activeBrowser null, detectChromium melapor hilang', async () => {
    const d = deps({ launcher: undefined, exists: () => false })
    await expect(startBrowser(d)).resolves.toBeUndefined()
    expect(activeBrowser()).toBeNull()
    expect(detectChromium(d.env, d.exists)).toBeNull()
  })

  it('stop menutup halaman fake sebelum runtime', async () => {
    await startBrowser(deps())
    const rt = activeBrowser()
    if (!rt) throw new Error('runtime tidak menyala')
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws) => rt.gateway(ws, 'w1'))
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`)
    cleanup.push(async () => { client.terminate(); await new Promise<void>((r) => wss.close(() => r())) })
    await new Promise<void>((r) => client.once('open', () => r()))
    client.send(JSON.stringify({ t: 'attach', id: 'b1', w: 800, h: 600, dpr: 1 }))
    await until(() => rt.status().live === 1)
    await stopBrowser()
    expect(fake.methods()).toContain('Target.closeTarget')
    expect(activeBrowser()).toBeNull()
  })
})

describe('registerBrowserCapability', () => {
  it('reconcile menyalakan lalu mematikan lewat hook kemampuan', async () => {
    const off = registerBrowserCapability(deps())
    cleanup.push(off)
    await reconcile(new Set(), new Set(['browser']))
    expect(activeBrowser()).not.toBeNull()
    await reconcile(new Set(['browser']), new Set())
    expect(activeBrowser()).toBeNull()
  })
})

describe('detectChromium', () => {
  it('env eksplisit menang atas lokasi umum', () => {
    expect(detectChromium({ [ENV_BROWSER.bin]: '/opt/c' }, () => true)).toEqual({ path: '/opt/c', source: 'env' })
  })
  it('env eksplisit yang hilang tidak jatuh diam-diam ke lokasi umum', () => {
    expect(detectChromium({ [ENV_BROWSER.bin]: '/opt/c' }, (p) => p !== '/opt/c')).toBeNull()
  })
  it('auto: lokasi umum pertama yang ada', () => {
    const r = detectChromium({}, (p) => p === '/usr/bin/chromium')
    expect(r).toEqual({ path: '/usr/bin/chromium', source: 'auto' })
  })
  it('tak ada = null', () => {
    expect(detectChromium({}, () => false)).toBeNull()
  })
})
