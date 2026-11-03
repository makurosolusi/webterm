// Sambungan klien node browser: serializer, daftar node, menu, status fitur, dan ikatan socket ke workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WsNode } from '../shared/workspace'
import { toFlow, toWsNode } from './store'
import { nodeRowLabel, NODE_KIND_LABEL } from './nodeList'
import { buildCanvasMenuRows, isSeparator } from './canvasMenu.model'
import { loadBrowserStatus, resetBrowserStatusCache } from './browser.feature'
import { setBrowserWorkspace, getBrowserWorkspace, browserStream } from './browser.stream'

const BROWSER: WsNode = { id: 'b1', kind: 'browser', x: 1, y: 2, url: 'https://example.com/', agentControl: true }

describe('serializer node browser', () => {
  it('url dan agentControl selamat di round-trip toFlow -> toWsNode', () => {
    const back = toWsNode(toFlow(BROWSER))
    expect(back).toMatchObject({ kind: 'browser', url: 'https://example.com/', agentControl: true })
  })
  it('node non-browser tidak mendapat field itu', () => {
    const back = toWsNode(toFlow({ id: 't', kind: 'terminal', x: 0, y: 0 }))
    expect(back.url).toBeUndefined()
    expect(back.agentControl).toBeUndefined()
  })
  it('judul baris tab Nodes: judul kustom, kalau tidak "Browser" (bukan "Terminal")', () => {
    expect(nodeRowLabel(BROWSER)).toBe(NODE_KIND_LABEL.browser)
    expect(nodeRowLabel({ ...BROWSER, title: 'docs' })).toBe('docs')
  })
})

describe('menu canvas', () => {
  const h = { addTerminal: vi.fn(), addAgent: vi.fn(), addFiles: vi.fn(), fitView: vi.fn() }
  const ctx = { nodeCount: 0, disabledAgents: [], customAgents: [], agentLaunchCommands: {} }
  const keys = (rows: ReturnType<typeof buildCanvasMenuRows>) => rows.flatMap((r) => (isSeparator(r) ? [] : [r.key]))
  it('tanpa handler addBrowser (flag mati) barisnya tidak ada; dengan handler ia ada dan memanggilnya', () => {
    expect(keys(buildCanvasMenuRows(h, ctx))).not.toContain('browser')
    const addBrowser = vi.fn()
    const row = buildCanvasMenuRows({ ...h, addBrowser }, ctx).find((r) => !isSeparator(r) && r.key === 'browser')
    expect(row && !isSeparator(row) && row.label).toBe('New Browser')
    if (row && !isSeparator(row)) row.onClick?.()
    expect(addBrowser).toHaveBeenCalledOnce()
  })
})

describe('status fitur', () => {
  beforeEach(resetBrowserStatusCache)
  afterEach(() => vi.unstubAllGlobals())
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
  it('404 (flag mati) = null dan dicoba lagi pada panggilan berikutnya', async () => {
    stub(404, { error: 'disabled' })
    expect(await loadBrowserStatus()).toBeNull()
    expect(await loadBrowserStatus()).toBeNull()
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2)
  })
  it('enabled=true di-cache: satu fetch untuk banyak pemanggil', async () => {
    const st = { enabled: true, binFound: true, live: 0, maxLive: 2, agentEnabled: true, cookieImportEnabled: false }
    stub(200, st)
    expect(await loadBrowserStatus()).toEqual(st)
    expect(await loadBrowserStatus()).toEqual(st)
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })
  it('enabled=false dari server diperlakukan mati', async () => {
    stub(200, { enabled: false, binFound: false, live: 0, maxLive: 0, agentEnabled: false, cookieImportEnabled: false })
    expect(await loadBrowserStatus()).toBeNull()
  })
})

describe('socket bersama terikat workspace', () => {
  class Ws {
    static all: Ws[] = []
    binaryType = ''; readyState = 0; closed = false
    onopen: (() => void) | null = null; onmessage: (() => void) | null = null
    onclose: (() => void) | null = null; onerror: (() => void) | null = null
    constructor(readonly url: string) { Ws.all.push(this) }
    send() {}
    close() { this.closed = true; this.readyState = 3; this.onclose?.() }
  }
  beforeEach(() => { Ws.all = []; vi.stubGlobal('WebSocket', Ws); vi.stubGlobal('location', { protocol: 'http:', host: 'h:1' }) })
  afterEach(() => { setBrowserWorkspace(''); vi.unstubAllGlobals() })
  it('attach memakai workspaceId di query; ganti workspace menutup socket lama dan membuka yang baru', () => {
    setBrowserWorkspace('w1')
    expect(getBrowserWorkspace()).toBe('w1')
    browserStream.attach('n1', { w: 10, h: 10, dpr: 1 })
    expect(new URL(Ws.all[0].url).searchParams.get('workspaceId')).toBe('w1')
    setBrowserWorkspace('w1') // sama = tidak melakukan apa-apa
    expect(Ws.all).toHaveLength(1)
    setBrowserWorkspace('w 2/x')
    expect(Ws.all[0].closed).toBe(true)
    browserStream.attach('n2', { w: 10, h: 10, dpr: 1 })
    expect(Ws.all).toHaveLength(2)
    expect(new URL(Ws.all[1].url).searchParams.get('workspaceId')).toBe('w 2/x')
    browserStream.detach('n2')
  })
})
