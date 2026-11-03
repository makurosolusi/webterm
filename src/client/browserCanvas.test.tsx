/** @vitest-environment jsdom */
// Node browser di canvas App yang SUNGGUHAN: flag server mati = tidak ada jejaknya (menu, dock,
// request, socket); flag menyala = baris "Browser" lahir, node ter-mount, socket terikat workspace.
// Chromium dan server tidak ada: fetch dan WebSocket dipalsukan.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserStatusResp } from '../shared/browser.contract'
import { resetBrowserStatusCache } from './browser.feature'
import { HARNESS_WS_ID, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { TOOLBAR_TEXT } from './browser.uxText'
import { MENU_LABELS } from './canvasMenu.model'

const urls: string[] = []
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
beforeEach(() => { urls.length = 0; resetBrowserStatusCache() })
afterEach(unmountCanvas)

const stubWs = () => vi.stubGlobal('WebSocket', FakeWs)
const fetched = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))

describe('flag browser mati (default)', () => {
  it('Add node tidak punya item Browser, menu pane tidak punya baris Browser, dan tidak ada socket', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    stubWs()
    await waitFor(() => expect(fetched()).toContain('/api/browser/status'))
    fireEvent.click(screen.getByLabelText('Add node'))
    await screen.findByRole('option', { name: 'Terminal' })
    expect(screen.queryByRole('option', { name: 'Browser' })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    fireEvent.contextMenu(document.querySelector('.react-flow__pane') as HTMLElement, { clientX: 50, clientY: 50 })
    await screen.findByText(MENU_LABELS.terminal)
    expect(screen.queryByText(MENU_LABELS.browser)).toBeNull()
    expect(urls).toEqual([])
    // Satu-satunya request browser dari klien: probe status (404 => fitur tak ada).
    expect(fetched().filter((u) => u.startsWith('/api/browser/'))).toEqual(['/api/browser/status'])
  })
})

describe('flag browser menyala', () => {
  it('item Browser melahirkan node browser dan socket-nya terikat ke workspace aktif', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS })
    stubWs()
    fireEvent.click(screen.getByLabelText('Add node'))
    fireEvent.click(await screen.findByRole('option', { name: 'Browser' }))

    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
    await waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toContain('/ws/browser')
    expect(new URL(urls[0]).searchParams.get('workspaceId')).toBe(HARNESS_WS_ID)
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
})
