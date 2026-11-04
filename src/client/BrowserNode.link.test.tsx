/** @vitest-environment jsdom */
// Kabel agent↔browser di canvas SUNGGUHAN. Kabel inilah izin agent mengemudikan browser
// (`resolveLinkedBrowser` server membaca `ws.bridges` lewat `linkedPeerIds`), jadi yang dibuktikan:
// node browser punya handle, menyambungnya ke node agent (dua arah) MENYIMPAN bridge, dan sambungan
// yang tak berguna tetap ditolak. Sambungan dibuat dengan click-connect React Flow (klik handle
// sumber lalu handle tujuan) — jalur `onConnect` yang sama dengan drag.
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserStatusResp } from '../shared/browser.contract'
import type { BridgeLink, Workspace, WsNode } from '../shared/workspace'
import { resetBrowserStatusCache } from './browser.feature'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import { resetCapabilitiesCache } from './useCapabilities'

class FakeWs {
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() { this.readyState = 3 }
}
const STATUS: BrowserStatusResp = { enabled: true, binFound: true, live: 0, maxLive: 2, agentEnabled: true, cookieImportEnabled: false }

const agent: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'claude' }
const browser: WsNode = { id: 'br-1', kind: 'browser', x: 600, y: 0, width: 420, height: 320 }
const browser2: WsNode = { id: 'br-2', kind: 'browser', x: 600, y: 400, width: 420, height: 320 }
const shell: WsNode = { id: 'term-1', kind: 'terminal', x: 0, y: 400, width: 420, height: 320, cwd: '/' }

beforeAll(installCanvasDom)
beforeEach(() => { resetBrowserStatusCache(); resetCapabilitiesCache() })
afterEach(unmountCanvas)

async function mount(nodes: WsNode[], bridges: BridgeLink[] = []): Promise<void> {
  await mountCanvas({ nodes, bridges, dirs: {}, browserStatus: STATUS })
  vi.stubGlobal('WebSocket', FakeWs)
  // jsdom tak punya hit-test; null = React Flow memakai handle yang diklik (`isValidHandle`).
  document.elementFromPoint = () => null
  await waitFor(() => expect(document.querySelectorAll('.react-flow__node-browser').length).toBeGreaterThan(0))
}

const handle = (nodeId: string, id: 'link-out' | 'link-in'): HTMLElement => {
  const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${id}"]`)
  if (!el) throw new Error(`handle ${id} node ${nodeId} tidak ada`)
  return el as HTMLElement
}

/** Bridge terakhir yang DIKIRIM ke server (PUT workspace) — persis yang dibaca `linkedPeerIds`. */
function savedBridges(): BridgeLink[] | undefined {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
  const puts = calls.filter(([u, init]) => String(u).startsWith('/api/workspaces/') && init?.method === 'PUT')
  const last = puts.at(-1)?.[1]?.body
  return last ? (JSON.parse(String(last)) as Workspace).bridges : undefined
}

/** Salinan `linkedPeerIds` server (src/server/contextLinkRoute.ts) — kontrak bridge dua arah. */
const peersOf = (bridges: BridgeLink[], id: string) =>
  new Set(bridges.flatMap((b) => (b.source === id ? [b.target] : b.target === id ? [b.source] : [])))

function connect(fromNode: string, toNode: string): void {
  fireEvent.click(handle(fromNode, 'link-out'))
  fireEvent.click(handle(toNode, 'link-in'))
}

describe('kabel agent ↔ browser', () => {
  it('node browser merender handle kabel kiri dan kanan', async () => {
    await mount([browser])
    expect(handle('br-1', 'link-out').classList).toContain('bridge-handle')
    expect(handle('br-1', 'link-in').classList).toContain('bridge-handle')
  })

  it('agent → browser menyimpan bridge yang dilihat linkedPeerIds', async () => {
    await mount([agent, browser])
    connect('agent-1', 'br-1')
    await waitFor(() => expect(savedBridges()).toBeDefined(), { timeout: 3000 })
    const bridges = savedBridges()!
    expect(bridges).toEqual([{ id: 'bridge-agent-1-br-1', source: 'agent-1', target: 'br-1', kind: 'context' }])
    expect(peersOf(bridges, 'agent-1').has('br-1')).toBe(true)
    await waitFor(() => expect(renderedEdgeIds()).toContain('bridge-agent-1-br-1'))
  })

  it('browser → agent juga tersimpan dan terlihat dari sisi agent', async () => {
    await mount([agent, browser])
    connect('br-1', 'agent-1')
    await waitFor(() => expect(savedBridges()).toBeDefined(), { timeout: 3000 })
    expect(peersOf(savedBridges()!, 'agent-1').has('br-1')).toBe(true)
  })

  it('kabel yang sudah ada (arah sebaliknya) tidak diduplikasi', async () => {
    await mount([agent, browser], [{ id: 'bridge-agent-1-br-1', source: 'agent-1', target: 'br-1', kind: 'context' }])
    await waitFor(() => expect(renderedEdgeIds()).toEqual(['bridge-agent-1-br-1']))
    connect('br-1', 'agent-1')
    await new Promise((r) => setTimeout(r, 700)) // lewati debounce simpan
    // Simpan lain (ukuran node dsb.) boleh terjadi; yang dilarang bridge kedua.
    expect(savedBridges() ?? []).toHaveLength(savedBridges() ? 1 : 0)
    expect(renderedEdgeIds()).toEqual(['bridge-agent-1-br-1'])
  })

  it('browser ↔ browser ditolak', async () => {
    await mount([browser, browser2])
    connect('br-1', 'br-2')
    await new Promise((r) => setTimeout(r, 700))
    expect(savedBridges() ?? []).toEqual([])
    expect(renderedEdgeIds()).toEqual([])
  })

  it('terminal biasa tidak punya handle (tak memegang token node, tak bisa mengemudi)', async () => {
    await mount([shell, browser])
    expect(document.querySelector('.react-flow__node[data-id="term-1"] .react-flow__handle')).toBeNull()
  })
})
