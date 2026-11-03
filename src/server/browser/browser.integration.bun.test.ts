// Bun-only: runtime browser utuh (host + lease + lifecycle + gateway + API + control) di atas server CDP TIRUAN.
// Chromium nyata TIDAK dipakai dan TIDAK diuji; yang dibuktikan di sini adalah perakitannya (WS-11).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { authorizeRequest, TOKEN_HEADER } from '../auth'
import { CapabilityStore, allows } from '../control/capabilities'
import { createFileSecretStore } from '../envSecrets.store'
import { BROWSER_ACT_CAP_ENV, BROWSER_READ_CAP_ENV } from '../browserAgentShim'
import { startBrowserRuntime } from './browser.runtime'
import { activeBrowser, setActiveBrowser } from './browser.state'
import type { BrowserRuntime } from './browser.state'
import { startFakeCdp } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

const WS: Workspace = {
  id: 'w1', name: 'w', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }, { id: 'b1', kind: 'browser', x: 0, y: 0, url: 'https://example.com/', agentControl: true }],
}
const ON = { [ENV_BROWSER.enabled]: 'on', [ENV_BROWSER.agent]: 'on', [ENV_BROWSER.cookieImport]: 'on' }

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

async function boot(env: Record<string, string> = ON) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-brint-'))
  const fake: FakeCdp = await startFakeCdp()
  const capabilities = new CapabilityStore()
  const rt = await startBrowserRuntime({
    env, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')), capabilities,
    workspaces: () => [WS], launcher: { acquire: async () => fake.url, shutdown: () => undefined },
  })
  cleanup.push(async () => { await rt?.shutdown(); await fake.close(); rmSync(dir, { recursive: true, force: true }) })
  return { rt, fake, capabilities }
}

const body = (s = '') => async () => s
const ctl = (rt: BrowserRuntime, store: CapabilityStore, verb: string, token?: string, payload: unknown = {}) => {
  const caps = { verify: (t: string) => store.verify(t), allows }
  return rt.control({ method: verb === 'status' ? 'GET' : 'POST', path: `/api/control/browser/b1/${verb}`, body: payload, headers: token ? { 'x-webterm-capability': token } : {} }, caps)
}

describe('flag off = tidak ada runtime', () => {
  test('startBrowserRuntime mengembalikan null untuk flag kosong/off/bukan "on", tanpa membuka port', async () => {
    for (const v of [undefined, '', 'off', '0', 'true']) {
      const rt = await startBrowserRuntime({ env: v === undefined ? {} : { [ENV_BROWSER.enabled]: v }, webtermPort: 8700, dataRoot: '/nonexistent', secrets: createFileSecretStore('/nonexistent'), capabilities: new CapabilityStore(), workspaces: () => [] })
      expect(rt).toBeNull()
    }
    setActiveBrowser(null)
    expect(activeBrowser()).toBeNull()
  })
  test('allow-hosts rusak mematikan fitur (null), bukan melempar', async () => {
    const { rt } = await boot({ ...ON, [ENV_BROWSER.allowHosts]: '*' })
    expect(rt).toBeNull()
  })
})

describe('runtime menyala di atas CDP tiruan', () => {
  test('status melaporkan fitur menyala; cookie DELETE memakai domain di path', async () => {
    const { rt, fake } = await boot()
    fake.handle('Storage.getCookies', () => ({ cookies: [] }))
    expect(rt?.status()).toMatchObject({ enabled: true, binFound: true, live: 0, agentEnabled: true, cookieImportEnabled: true })
    const st = await rt?.api('GET', '/api/browser/status', body())
    expect(st).toMatchObject({ status: 200, body: { enabled: true } })
    const del = await rt?.api('DELETE', '/api/browser/w1/cookies/a.com', body())
    expect(del?.status).toBe(204)
    expect((await rt?.api('GET', '/api/other', body())) ?? null).toBeNull()
  })

  test('gateway: attach membuka target di CDP tiruan, state live dan frame biner sampai ke klien', async () => {
    const { rt, fake } = await boot()
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws) => rt?.gateway(ws, 'w1'))
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`)
    const json: Array<Record<string, unknown>> = []
    let frames = 0
    client.on('message', (d, bin) => { if (bin) frames++; else json.push(JSON.parse(String(d))) })
    cleanup.push(() => new Promise<void>((r) => { client.terminate(); wss.close(() => r()) }))
    await new Promise<void>((r) => client.once('open', () => r()))
    client.send(JSON.stringify({ t: 'attach', id: 'b1', w: 800, h: 600, dpr: 1 }))
    const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true) }
    await until(() => json.some((m) => m.t === 'state' && m.live === 'live'))
    expect(fake.methods()).toContain('Target.createTarget')
    expect(fake.methods()).toContain('Page.navigate')
    fake.emit('Page.screencastFrame', { data: Buffer.from('jpeg').toString('base64'), sessionId: 7, metadata: {} }, 'S-T1')
    await until(() => frames > 0)
    expect(rt?.status().live).toBe(1)
  })

  test('capability dari hook sesi: read boleh status, act ditolak untuk verb read, tanpa capability 401, token node 401', async () => {
    const { rt, capabilities } = await boot()
    if (!rt) throw new Error('runtime tidak menyala')
    const env = rt.sessionHook.envFor('a1', 'claude')
    const read = env[BROWSER_READ_CAP_ENV], act = env[BROWSER_ACT_CAP_ENV]
    expect(read).toBeTruthy(); expect(act).toBeTruthy()

    // 404 = lolos auth+flag tetapi node b1 belum live di host (belum ada attach); yang dibuktikan di sini adalah gerbangnya.
    expect((await ctl(rt, capabilities, 'status', read))?.status).toBe(404)
    expect((await ctl(rt, capabilities, 'navigate', read, { url: 'https://example.com/' }))?.status).toBe(403) // read tak boleh act
    expect((await ctl(rt, capabilities, 'status'))?.status).toBe(401)
    // Token node (per sesi agent) BUKAN capability browser: handler menolaknya walau gerbang auth meloloskannya.
    expect((await ctl(rt, capabilities, 'status', 'nodeterm-node-token-bukan-capability'))?.status).toBe(401)
    expect((await ctl(rt, capabilities, 'status', act))?.status).toBe(403) // act tidak membawa browser.read
    rt.sessionHook.release('a1')
    expect((await ctl(rt, capabilities, 'status', read))?.status).toBe(401) // dicabut saat sesi tutup
  })

  test('shutdown idempotent dan menutup gateway baru', async () => {
    const { rt } = await boot()
    await rt?.shutdown()
    await rt?.shutdown()
  })
})

describe('gerbang auth: token node ditolak di /ws/browser dan /api/browser/*', () => {
  const NODE = 'node-token'
  const check = (pathname: string, headers: Record<string, string>) => authorizeRequest({
    headers, expectedToken: 'root-token', pathname, isNodeToken: (t) => t === NODE,
    isCapabilityToken: () => false,
  })
  test('token node tidak membuka permukaan browser; token root membukanya', () => {
    for (const p of ['/ws/browser', '/api/browser/status', '/api/browser/w1/cookies/domains', '/api/browser/w1/cookies/a.com', '/api/browser/b1/lease', '/api/browser/b1/agent-control']) {
      expect(check(p, { [TOKEN_HEADER]: NODE })).toBe(false)
      expect(check(p, { 'x-nodeterm-node-token': NODE })).toBe(false)
      expect(check(p, { [TOKEN_HEADER]: 'root-token' })).toBe(true)
    }
  })
  test('capability tidak membuka permukaan browser non-control (hanya /api/control/*)', () => {
    const capAuth = (p: string) => authorizeRequest({ headers: { 'x-webterm-capability': 'wcap_x' }, expectedToken: 'root-token', pathname: p, isNodeToken: () => false, isCapabilityToken: () => true })
    expect(capAuth('/api/browser/status')).toBe(false)
    expect(capAuth('/ws/browser')).toBe(false)
    expect(capAuth('/api/control/browser/b1/status')).toBe(true)
  })
})
