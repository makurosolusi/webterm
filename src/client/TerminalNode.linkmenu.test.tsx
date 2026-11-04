/**
 * @vitest-environment jsdom
 */
// Baris "Open in canvas browser" pada menu klik-kanan node terminal/agent, di canvas sungguhan.
// WebLinksAddon diganti tiruan yang menyimpan opsi `hover`/`leave`, jadi tes memicu hover persis
// seperti xterm tanpa butuh layout (jsdom tidak punya).
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBrowserStatusCache } from './browser.feature'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import type { BrowserStatusResp } from '../shared/browser.contract'
import type { WsNode } from '../shared/workspace'

const addon = vi.hoisted(() => ({ opts: [] as Array<{ hover?: (e: MouseEvent, t: string) => void; leave?: (e: MouseEvent, t: string) => void }> }))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(_h: unknown, o: (typeof addon.opts)[number]) { addon.opts.push(o) }
    activate() {}
    dispose() {}
  },
}))

const LINK = 'https://example.com/docs'
const LABEL = 'Open in canvas browser'
const ON: BrowserStatusResp = { enabled: true, binFound: true, live: 0, maxLive: 2, agentEnabled: false, cookieImportEnabled: false }
const termNode: WsNode = { id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell' }
const agentNode: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'agent' }

const menu = (): HTMLElement | null => document.querySelector('[role="menu"][data-slot="vscode-menu"]')
const labels = (): string[] => Array.from(menu()?.querySelectorAll('button') ?? []).map((b) => b.textContent ?? '')
const body = (kind: 'terminal' | 'agent'): HTMLElement => {
  const el = document.querySelector(`.react-flow__node-${kind} .node-body`)
  if (!el) throw new Error(`badan node ${kind} tidak dirender`)
  return el as HTMLElement
}
const ev = new MouseEvent('mousemove')
const hover = (text: string): void => { addon.opts.at(-1)?.hover?.(ev, text) }

async function openMenu(kind: 'terminal' | 'agent'): Promise<void> {
  fireEvent.contextMenu(body(kind), { clientX: 300, clientY: 220 })
  await waitFor(() => expect(menu()).not.toBeNull())
}

beforeAll(installCanvasDom)
// Status browser di-cache di level modul: tanpa reset, tes flag-mati mewarisi flag-ON tes sebelumnya.
beforeEach(resetBrowserStatusCache)
afterEach(() => { unmountCanvas(); addon.opts.length = 0; vi.restoreAllMocks() })

describe.each([['terminal', termNode], ['agent', agentNode]] as const)('menu link node %s', (kind, node) => {
  it('hover link + flag ON -> baris tampil, dan tetap ada setelah leave', async () => {
    await mountCanvas({ nodes: [node], dirs: {}, browserStatus: ON })
    hover(LINK)
    await openMenu(kind)
    addon.opts.at(-1)?.leave?.(ev, LINK) // kursor pindah ke menu
    expect(labels()).toContain(LABEL)
  })

  it('tanpa link terhover -> baris tidak ada', async () => {
    await mountCanvas({ nodes: [node], dirs: {}, browserStatus: ON })
    await openMenu(kind)
    expect(labels()).not.toContain(LABEL)
  })

  it('browser mati -> baris tetap ada (memunculkan tawaran Nyalakan, lihat browserLinkOffer.test)', async () => {
    await mountCanvas({ nodes: [node], dirs: {} })
    hover(LINK)
    await openMenu(kind)
    expect(labels()).toContain(LABEL)
  })
})

describe('klik baris', () => {
  it('melahirkan satu node browser berurl link itu di sebelah sumbernya', async () => {
    await mountCanvas({ nodes: [termNode], dirs: {}, browserStatus: ON })
    hover(LINK)
    await openMenu('terminal')
    const row = Array.from(menu()?.querySelectorAll('button') ?? []).find((b) => b.textContent === LABEL) as HTMLElement
    fireEvent.pointerDown(row)
    fireEvent.click(row)
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser')).toHaveLength(1))
  })
})
