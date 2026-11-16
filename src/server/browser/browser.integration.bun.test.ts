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
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { startBrowserRuntime } from './browser.runtime'
import { activeBrowser, setActiveBrowser } from './browser.state'
import type { BrowserRuntime } from './browser.state'
import { startFakeCdp, offlineAdblock } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

const WS: Workspace = {
  id: 'w1', name: 'w', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }, { id: 'b1', kind: 'browser', x: 0, y: 0, url: 'https://example.com/', agentControl: true }],
}
const ON = { [ENV_BROWSER.enabled]: 'on', [ENV_BROWSER.agent]: 'on', [ENV_BROWSER.cookieImport]: 'on' }

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

async function boot(env: Record<string, string> = ON, onAgentUse?: () => void, workspaces: () => Workspace[] = () => [WS]) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-brint-'))
  const fake: FakeCdp = await startFakeCdp()
  const capabilities = new CapabilityStore()
  const rt = await startBrowserRuntime({
    env, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')), onAgentUse,
    workspaces, launcher: { acquire: async () => fake.url, shutdown: () => undefined }, adblock: offlineAdblock(),
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
  test('startBrowserRuntime mengembalikan null untuk flag kosong/off/nilai tak dikenal (bukan on|1|true), tanpa membuka port', async () => {
    for (const v of [undefined, '', 'off', '0', 'yes']) {
      const rt = await startBrowserRuntime({ env: v === undefined ? {} : { [ENV_BROWSER.enabled]: v }, webtermPort: 8700, dataRoot: '/nonexistent', secrets: createFileSecretStore('/nonexistent'), workspaces: () => [] })
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

  test('impor cookie menyala bersama browser tanpa env cookie; hanya off eksplisit yang mematikan', async () => {
    const preview = (rt: BrowserRuntime | null) => rt?.api('POST', '/api/browser/w1/cookies/preview', body('{}'))
    const { rt } = await boot({ [ENV_BROWSER.enabled]: 'on' })
    expect(rt?.status().cookieImportEnabled).toBe(true)
    expect(await rt?.api('GET', '/api/browser/status', body())).toMatchObject({ status: 200, body: { cookieImportEnabled: true } })
    expect((await preview(rt))?.status).toBe(400) // rute hidup: body kosong ditolak validasi, bukan 404 disabled
    const off = (await boot({ [ENV_BROWSER.enabled]: 'on', [ENV_BROWSER.cookieImport]: 'off' })).rt
    expect(off?.status().cookieImportEnabled).toBe(false)
    expect(await preview(off)).toMatchObject({ status: 404, body: { error: 'disabled' } })
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
    // Central removed the node from its board: the page closes now, not on the idle timer.
    await rt?.closeNode('b1')
    expect(fake.methods()).toContain('Target.closeTarget')
    await until(() => rt?.status().live === 0)
  })

  test('default on: shim dipasang saat start; kabel dipasang SETELAH sesi jalan langsung berlaku, dilepas = ditolak', async () => {
    const board: Workspace = { ...WS, bridges: [], nodes: [WS.nodes[0], { id: 'b1', kind: 'browser', x: 0, y: 0 }] } // agentControl absen = on
    let installs = 0
    const { rt, capabilities } = await boot({ [ENV_BROWSER.enabled]: 'on' }, () => { installs++ }, () => [board])
    if (!rt) throw new Error('runtime tidak menyala')
    expect(installs).toBe(1)
    expect(rt.status().agentEnabled).toBe(true)
    const tok = nodeToken('a1')
    cleanup.push(() => forgetNodeToken('a1'))
    const asAgent = (path: string) => rt.control({ method: 'GET', path, headers: { [TOKEN_HEADER]: tok } }, { verify: (t: string) => capabilities.verify(t), allows })
    expect(await asAgent('/api/control/browser/status')).toMatchObject({ status: 404, body: { error: 'no_linked_browser', available: [{ id: 'b1' }] } })
    board.bridges.push({ id: 'l1', source: 'a1', target: 'b1', kind: 'context' }) // user menyambung kabel; tanpa restart
    // 404 not_found = lolos auth+kabel+flag, b1 hanya belum live di host (belum attach).
    expect(await asAgent('/api/control/browser/status')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    expect(await asAgent('/api/control/browser/b1/status')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    board.bridges.length = 0 // kabel dilepas = izin dicabut
    expect(await asAgent('/api/control/browser/b1/status')).toMatchObject({ status: 403, body: { error: 'not_linked' } })
    expect((await asAgent('/api/control/browser/status'))?.status).toBe(404)
    // Tanpa identitas node (token asing) = 401, walau gerbang auth meloloskannya.
    const anon = await rt.control({ method: 'GET', path: '/api/control/browser/b1/status', headers: { [TOKEN_HEADER]: 'bukan-token-node' } }, { verify: () => undefined, allows })
    expect(anon?.status).toBe(401)
  })

  test('off eksplisit dihormati: sub-opsi off atau toggle node off = disabled untuk agent bertali', async () => {
    const board: Workspace = { ...WS, bridges: [{ id: 'l1', source: 'a1', target: 'b1', kind: 'context' }], nodes: [WS.nodes[0], { id: 'b1', kind: 'browser', x: 0, y: 0, agentControl: false }] }
    const env: Record<string, string> = { [ENV_BROWSER.enabled]: 'on' }
    const { rt, capabilities } = await boot(env, undefined, () => [board])
    if (!rt) throw new Error('runtime tidak menyala')
    const tok = nodeToken('a1')
    cleanup.push(() => forgetNodeToken('a1'))
    const caps = { verify: (t: string) => capabilities.verify(t), allows }
    const status = () => rt.control({ method: 'GET', path: '/api/control/browser/status', headers: { [TOKEN_HEADER]: tok } }, caps)
    expect(await status()).toMatchObject({ status: 403, body: { error: 'disabled' } })
    board.nodes[1] = { ...board.nodes[1], agentControl: undefined }
    expect((await status())?.status).toBe(404) // lolos gerbang (node belum live)
    env[ENV_BROWSER.agent] = 'off'
    expect(rt.status().agentEnabled).toBe(false)
    expect(await status()).toMatchObject({ status: 403, body: { error: 'disabled' } })
  })

  test('agent bertali: navigate pada node segar langsung jalan tanpa handoff, end of turn mengembalikan ke human', async () => {
    const board: Workspace = { ...WS, bridges: [{ id: 'l1', source: 'a1', target: 'b1', kind: 'context' }] }
    const { rt, fake, capabilities } = await boot(ON, undefined, () => [board])
    if (!rt) throw new Error('runtime tidak menyala')
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws) => rt.gateway(ws, 'w1'))
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`)
    const json: Array<Record<string, unknown>> = []
    client.on('message', (d, bin) => { if (!bin) json.push(JSON.parse(String(d))) })
    cleanup.push(() => new Promise<void>((r) => { client.terminate(); wss.close(() => r()) }))
    await new Promise<void>((r) => client.once('open', () => r()))
    client.send(JSON.stringify({ t: 'attach', id: 'b1', w: 800, h: 600, dpr: 1 }))
    const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true) }
    await until(() => json.some((m) => m.t === 'state' && m.live === 'live'))
    const tok = nodeToken('a1')
    cleanup.push(() => forgetNodeToken('a1'))
    const caps = { verify: (t: string) => capabilities.verify(t), allows }
    const asAgent = (verb: string, payload: unknown = {}) => rt.control({ method: verb === 'status' ? 'GET' : 'POST', path: `/api/control/browser/${verb}`, body: payload, headers: { [TOKEN_HEADER]: tok } }, caps)
    const navigates = fake.methods().filter((m) => m === 'Page.navigate').length
    expect(await asAgent('navigate', { url: 'https://example.com/next' })).toMatchObject({ status: 200 })
    expect(fake.methods().filter((m) => m === 'Page.navigate').length).toBe(navigates + 1)
    await until(() => json.some((m) => m.t === 'state' && m.lease === 'agent'))
    rt.releaseLease('b1')
    await until(() => (json.filter((m) => m.t === 'state').at(-1) as { lease?: string }).lease === 'human')
  })

  test('capability (Agent Pusat) tetap jalan: read boleh status, read tak boleh act, node wajib di path', async () => {
    const { rt, capabilities } = await boot()
    if (!rt) throw new Error('runtime tidak menyala')
    const read = capabilities.mint({ verb: 'browser.read', resource: 'node:b1', ttlMs: 60_000, mintedBy: 'test' })
    expect((await ctl(rt, capabilities, 'status', read))?.status).toBe(404)
    expect((await ctl(rt, capabilities, 'navigate', read, { url: 'https://example.com/' }))?.status).toBe(403)
    expect((await ctl(rt, capabilities, 'status'))?.status).toBe(401)
    const auto = await rt.control({ method: 'GET', path: '/api/control/browser/status', headers: { 'x-webterm-capability': read } }, { verify: (t: string) => capabilities.verify(t), allows })
    expect(auto?.status).toBe(400)
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
      expect(check(p, { 'x-webterm-node-token': NODE })).toBe(false)
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
