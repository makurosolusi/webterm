/** @vitest-environment jsdom */
// Node browser di canvas App yang SUNGGUHAN: flag server mati = tidak ada jejaknya (menu, dock,
// request, socket); flag menyala = baris "Browser" lahir, node ter-mount, socket terikat workspace.
// Chromium dan server tidak ada: fetch dan WebSocket dipalsukan.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_WS_PATH, type BrowserStatusResp } from '../shared/browser.contract'
import { resetBrowserStatusCache } from './browser.feature'
import { HARNESS_WS_ID, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { resetCapabilitiesCache } from './useCapabilities'
import { TOOLBAR_MENU_TEXT, TOOLBAR_TEXT } from './browser.uxText'
import { CI } from './browserCookies/cookieImport.text'
import { MENU_LABELS } from './canvasMenu.model'
// The Layers side bar's empty state offers the same "New Terminal" / "New Agent" buttons as the
// canvas menu; these queries mean the menu row, so the side bar is left out.
const OUTSIDE_SIDE_BAR = { ignore: 'script, style, .sessions-sidebar *' }

const urls: string[] = []
// The app also opens the shared terminal socket /ws eagerly at start; these tests are about the
// browser socket only.
const browserUrls = () => urls.filter((u) => new URL(u).pathname === BROWSER_WS_PATH)
class FakeWs {
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) { urls.push(url) }
  send() {}
  close() { this.readyState = 3 }
}
const STATUS: BrowserStatusResp = { enabled: true, binFound: true, live: 0, maxLive: 2, agentEnabled: false, cookieImportEnabled: false }

beforeAll(installCanvasDom)
beforeEach(() => { urls.length = 0; resetBrowserStatusCache(); resetCapabilitiesCache() })
afterEach(unmountCanvas)

const stubWs = () => vi.stubGlobal('WebSocket', FakeWs)
const fetched = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))

describe('flag browser mati (default)', () => {
  it('Add node dan menu pane tetap punya baris Browser (tawaran Nyalakan), dan tidak ada socket', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    stubWs()
    await waitFor(() => expect(fetched()).toContain('/api/browser/status'))
    fireEvent.click(screen.getByLabelText('Add node'))
    await screen.findByRole('option', { name: 'Terminal' })
    expect(screen.queryByRole('option', { name: 'Browser' })).not.toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement, { clientX: 50, clientY: 50 })
    await screen.findByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR)
    expect(screen.queryByText(MENU_LABELS.browser)).not.toBeNull()
    expect(browserUrls()).toEqual([])
    // Satu-satunya request browser dari klien: probe status (404 => fitur tak ada).
    expect(fetched().filter((u) => u.startsWith('/api/browser/'))).toEqual(['/api/browser/status'])
  })
})

// Server palsu untuk tawaran: kemampuan browser mati sampai POST /api/capabilities/browser; sesudahnya
// /api/browser/status menjawab. Rute lain diteruskan ke fetch harness.
function stubCapabilityServer(posts: string[], steps?: object): void {
  const inner = globalThis.fetch
  let on = false
  const cap = () => new Response(JSON.stringify({
    capabilities: [{ id: 'browser', title: 'Browser on canvas', blurb: 'Open web pages as nodes on the canvas.', status: on ? 'on' : steps ? 'needs-step' : 'off', ...(!on && steps ? steps : {}) }],
    advanced: {},
  }))
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/capabilities') return Promise.resolve(cap())
    if (path === '/api/capabilities/browser') { posts.push(String(init?.body)); on = true; return Promise.resolve(cap()) }
    if (path === '/api/browser/status' && on) return Promise.resolve(new Response(JSON.stringify(STATUS)))
    return inner(input, init)
  }))
}
const openPaneMenu = () => fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement, { clientX: 50, clientY: 50 })

describe('tawaran saat kemampuan browser mati', () => {
  it('klik baris Browser menampilkan Nyalakan di dalam menu; Nyalakan memanggil API lalu node lahir', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    stubWs()
    const posts: string[] = []
    stubCapabilityServer(posts)
    openPaneMenu()
    fireEvent.click(await screen.findByText(MENU_LABELS.browser))
    expect(await screen.findByText(/Turn it on now\?/)).not.toBeNull()
    expect(screen.queryByText(MENU_LABELS.terminal, OUTSIDE_SIDE_BAR)).toBeNull() // panel menu berganti isi
    expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
    expect(posts.map((b) => JSON.parse(b))).toEqual([{ enabled: true }])
    expect(screen.queryByText(/Turn it on now\?/)).toBeNull()
  })

  it('needs-step menampilkan langkah Chromium, bukan tombol Nyalakan', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    stubCapabilityServer([], { step: { kind: 'chromiumPath', label: 'Pilih lokasi Chromium' }, detail: 'Chromium belum ditemukan.' })
    openPaneMenu()
    fireEvent.click(await screen.findByText(MENU_LABELS.browser))
    expect(await screen.findByRole('button', { name: 'Pilih lokasi Chromium' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
  })

  it('teks status browser tidak menyebut nama env var; jalan keluarnya tombol tawaran, bukan teks petunjuk', async () => {
    const { browserNotice, noticeAction } = await import('./browser.status')
    for (const blocked of ['no_binary', 'disabled'] as const) {
      const n = browserNotice({ state: { blocked } as never, connected: true })
      expect(n?.text).not.toMatch(/WEBTERM_/)
      expect(noticeAction({ state: { blocked } as never })).toEqual({ kind: 'offer' })
    }
  })
})

describe('flag browser menyala', () => {
  it('item Browser melahirkan node browser dan socket-nya terikat ke workspace aktif', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS })
    stubWs()
    fireEvent.click(screen.getByLabelText('Add node'))
    fireEvent.click(await screen.findByRole('option', { name: 'Browser' }))

    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
    await waitFor(() => expect(browserUrls()).toHaveLength(1))
    expect(new URL(browserUrls()[0]).searchParams.get('workspaceId')).toBe(HARNESS_WS_ID)
    expect(screen.getByRole('toolbar', { name: TOOLBAR_TEXT.group })).not.toBeNull()
  })

  it('menu konteks pane punya baris New Browser', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS })
    stubWs()
    await waitFor(() => expect(fetched()).toContain('/api/browser/status'))
    await new Promise((r) => setTimeout(r, 20))
    fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement, { clientX: 50, clientY: 50 })
    fireEvent.click(await screen.findByText(MENU_LABELS.browser))
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
  })

  it('impor cookie lewat menu ⋮ toolbar: Import Cookies ▸ From File… + catatan Google membuka dialog; header node hanya aksi node', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: { ...STATUS, cookieImportEnabled: true } })
    stubWs()
    fireEvent.click(screen.getByLabelText('Add node'))
    fireEvent.click(await screen.findByRole('option', { name: 'Browser' }))
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
    const node = document.querySelector('.react-flow__node-browser') as HTMLElement
    expect(screen.queryByRole('button', { name: 'Cookies' })).toBeNull() // tombol ghost "Cookies" sudah diganti menu
    // Header "…" = node actions only: no page rows (cookies, reload) and no dead Search.
    fireEvent.click(node.querySelector('[data-title="More Actions…"]') as HTMLElement)
    await screen.findByText(/^Comments/)
    for (const page of [CI.menuItem, 'Refresh view', 'Search']) expect(screen.queryByText(page)).toBeNull()
    expect(node.querySelector('[data-title="Search"]')).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(within(node).getByRole('button', { name: TOOLBAR_TEXT.more }))
    fireEvent.click(await screen.findByText(CI.menuItem))
    expect(screen.queryByText('From File…')).toBeNull() // no submenu with a single entry
    expect(screen.queryByText(/Google logins can/)).toBeNull() // the Google note is in the dialog, not a menu row
    expect(screen.queryByText(/From (Google Chrome|Brave|Safari)/)).toBeNull() // webterm tak membaca store browser lain
    expect(await screen.findByRole('dialog', { name: CI.title })).not.toBeNull()
  })

  it('impor cookie mati di server: menu ⋮ tanpa Import Cookies', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS })
    stubWs()
    fireEvent.click(screen.getByLabelText('Add node'))
    fireEvent.click(await screen.findByRole('option', { name: 'Browser' }))
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
    fireEvent.click(within(document.querySelector('.react-flow__node-browser') as HTMLElement).getByRole('button', { name: TOOLBAR_TEXT.more }))
    await screen.findByText(TOOLBAR_MENU_TEXT.copyUrl)
    expect(screen.queryByText(CI.menuItem)).toBeNull()
  })
})
