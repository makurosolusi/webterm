// Bun: a NEW browser node as the owner makes it (a node created on the client with a profile, attached over /ws/browser
// before the board is saved), over the assembled runtime and a FAKE CDP server (no real Chromium). Covers the report
// "a new browser opened with a PROFILE: nearly nothing works": the profile must be the one picked, the page must open and
// receive `nav`, and a node the MAX_LIVE gate refuses must say so and wake by itself when a slot frees.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserProfile } from '../../shared/browser.profile'
import type { Workspace } from '../../shared/workspace'
import { createFileSecretStore } from '../envSecrets.store'
import { logBus } from '../logs'
import { startBrowserRuntime } from './browser.runtime'
import type { BrowserRuntime } from './browser.state'
import { offlineAdblock, startFakeCdp } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

interface Rig { rt: BrowserRuntime; fake: FakeCdp; acquired: string[]; connect(): Promise<Client> }
interface Client { json: Array<Record<string, unknown>>; send(m: unknown): void }

async function boot(env: Record<string, string> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-newnode-'))
  const fake = await startFakeCdp()
  const board: Workspace = { id: 'w1', name: 'Alpha', cwd: '/', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [] }
  const acquired: string[] = []
  const rt = await startBrowserRuntime({
    env: { [ENV_BROWSER.enabled]: 'on', ...env }, webtermPort: 8700, dataRoot: dir, secrets: createFileSecretStore(join(dir, 'secrets')), workspaces: () => [board],
    launcher: { acquire: async (id) => { acquired.push(id); return fake.url }, shutdown: () => undefined, isLive: () => false },
    adblock: offlineAdblock(),
  })
  if (!rt) throw new Error('runtime did not start')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  wss.on('connection', (ws) => rt.gateway(ws as never, 'w1'))
  const socks: WebSocket[] = []
  cleanup.push(async () => {
    for (const s of socks) s.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    await rt.shutdown(); await fake.close(); rmSync(dir, { recursive: true, force: true })
  })
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return {
    rt, fake, acquired,
    async connect() {
      const ws = new WebSocket(url)
      socks.push(ws)
      const c: Client = { json: [], send: (m) => ws.send(JSON.stringify(m)) }
      ws.on('message', (d, bin) => { if (!bin) c.json.push(JSON.parse(String(d))) })
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
      return c
    },
  }
}

const wait = async (cond: () => boolean, what: string, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const attach = (id: string, over = {}) => ({ t: 'attach', id, w: 800, h: 600, dpr: 1, ...over })
const make = async (r: Rig, name: string) => (await r.rt.api('POST', '/api/browser/profiles', async () => JSON.stringify({ name })))!.body as BrowserProfile
const has = (c: Client, id: string, t: string, code?: string) => c.json.some((m) => m.id === id && m.t === t && (code === undefined || m.code === code))

describe('a new node on a profile', () => {
  test('attach with the profile the client picked opens THAT profile, not the Default', async () => {
    const r = await boot()
    const p = await make(r, 'Work')
    const c = await r.connect()
    c.send(attach('new1', { profileId: p.id })) // the node is not on the saved board yet
    await wait(() => has(c, 'new1', 'state'), 'state')
    expect(r.acquired.filter((id) => id !== p.id && id !== 'w1')).toEqual([])
    expect(r.acquired).toContain(p.id)
    expect(r.acquired.slice(0, 1)).toEqual([p.id]) // the first process asked for is the picked profile
    expect(has(c, 'new1', 'tabs')).toBe(true) // the viewer gets the tab list
  })

  test('without the hint the unsaved node falls back to the Default (control for the test above)', async () => {
    const r = await boot()
    await make(r, 'Work')
    const c = await r.connect()
    c.send(attach('new2'))
    await wait(() => has(c, 'new2', 'state'), 'state')
    expect(r.acquired[0]).toBe('w1')
  })

  test('a profile of another board is never taken from a viewer hint', async () => {
    const r = await boot()
    const c = await r.connect()
    c.send(attach('new3', { profileId: 'bp-ffffffffffff' })) // unknown id
    await wait(() => has(c, 'new3', 'state'), 'state')
    expect(r.acquired[0]).toBe('w1')
  })

  test('nav and input reach the page of the new node (fake CDP does not emit page events, so the CDP calls are the proof)', async () => {
    const r = await boot()
    const p = await make(r, 'Work')
    const c = await r.connect()
    c.send(attach('new4', { profileId: p.id }))
    await wait(() => has(c, 'new4', 'state'), 'state')
    c.send({ t: 'nav', id: 'new4', action: 'go', url: 'https://example.com/' })
    await wait(() => r.fake.calls.some((x) => x.method === 'Page.navigate' && String(x.params.url).startsWith('https://example.com')), 'Page.navigate')
    c.send({ t: 'mouse', id: 'new4', type: 'down', x: 10, y: 10, button: 'left', clickCount: 1 })
    await wait(() => r.fake.calls.some((x) => x.method === 'Input.dispatchMouseEvent'), 'Input.dispatchMouseEvent')
    expect(c.json.filter((m) => m.t === 'error')).toEqual([])
  })
})

describe('MAX_LIVE gate', () => {
  test('the refused node gets its own error and a log line, then wakes when a slot frees', async () => {
    const r = await boot({ [ENV_BROWSER.maxLive]: '1' })
    logBus.clear()
    const a = await r.connect()
    a.send(attach('first'))
    await wait(() => has(a, 'first', 'state'), 'first live')
    const b = await r.connect()
    b.send(attach('second'))
    await wait(() => has(b, 'second', 'error', 'max_live'), 'refusal')
    expect(has(b, 'second', 'state')).toBe(false)
    const warn = logBus.snapshot().find((e) => e.event === 'browser.attach_refused')
    expect(warn).toMatchObject({ level: 'warn', ids: { nodeId: 'second' }, data: { reason: 'max_live', maxLive: 1 } })
    a.send({ t: 'detach', id: 'first' }) // hidden: evictable, the waiting node takes the slot without asking again
    await wait(() => has(b, 'second', 'state'), 'second wakes')
  })
})
