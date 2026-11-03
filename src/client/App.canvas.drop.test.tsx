/** @vitest-environment jsdom */
// Drop URL ke canvas App yang SUNGGUHAN: pane kosong melahirkan node browser di titik drop;
// drop di atas node atau saat flag browser mati tidak mengubah apa pun. Chromium/WS dipalsukan.
import { createEvent, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserStatusResp } from '../shared/browser.contract'
import type { WsNode } from '../shared/workspace'
import { resetBrowserStatusCache } from './browser.feature'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'

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
const STATUS: BrowserStatusResp = { enabled: true, binFound: true, live: 0, maxLive: 2, agentEnabled: false, cookieImportEnabled: false }
const DROP_URL = 'https://example.com/halaman'
const VIEWPORT = { x: 100, y: 50, zoom: 1 }
const POINT = { clientX: 400, clientY: 300 }
// jsdom tanpa layout: rect pane nol, jadi flow = layar - offset viewport.
const EXPECTED_AT = { x: POINT.clientX - VIEWPORT.x, y: POINT.clientY - VIEWPORT.y }
const filesNode: WsNode = { id: 'files-node', kind: 'files', x: 0, y: 0, width: 420, height: 320, dirPath: '/p', title: 'p' }

beforeAll(installCanvasDom)
beforeEach(() => { resetBrowserStatusCache(); vi.stubGlobal('WebSocket', FakeWs) })
afterEach(unmountCanvas)

const pane = () => document.querySelector('.react-flow__pane') as HTMLElement
const browserNodes = () => document.querySelectorAll('.react-flow__node-browser')

/** Event drag `cancelable` dengan dataTransfer palsu (jsdom tak punya DataTransfer). */
function drag(type: 'dragOver' | 'drop', target: Element, data: Record<string, string>) {
  const dt = { types: Object.keys(data), getData: (t: string) => data[t] ?? '', files: [] }
  // jsdom tak punya DragEvent: koordinat harus ditempel manual agar handler membacanya.
  const ev = Object.assign(createEvent[type](target, { dataTransfer: dt }), POINT)
  fireEvent(target, ev)
  return ev
}

describe('drop URL ke canvas', () => {
  it('drop di pane melahirkan node browser di titik drop (koordinat flow)', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS, viewport: VIEWPORT })
    await waitFor(() => expect(drag('dragOver', pane(), { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(true))
    expect(drag('drop', pane(), { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(true)

    await waitFor(() => expect(browserNodes()).toHaveLength(1))
    const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((browserNodes()[0] as HTMLElement).style.transform) ?? []
    expect({ x: Number(x), y: Number(y) }).toEqual(EXPECTED_AT)
  })

  it('teks bukan URL tidak melahirkan node', async () => {
    await mountCanvas({ nodes: [], dirs: {}, browserStatus: STATUS, viewport: VIEWPORT })
    await waitFor(() => expect(drag('dragOver', pane(), { 'text/plain': 'halo' }).defaultPrevented).toBe(true))
    drag('drop', pane(), { 'text/plain': 'halo' })
    await new Promise((r) => setTimeout(r, 20))
    expect(browserNodes()).toHaveLength(0)
  })

  it('drop di atas node tidak memicu dan tidak dicegah', async () => {
    await mountCanvas({ nodes: [filesNode], dirs: { '/p': [] }, browserStatus: STATUS, viewport: VIEWPORT })
    const node = document.querySelector('.react-flow__node') as HTMLElement
    expect(drag('dragOver', node, { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(false)
    expect(drag('drop', node, { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(browserNodes()).toHaveLength(0)
  })

  it('flag browser mati: preventDefault tidak dipanggil dan tidak ada node', async () => {
    await mountCanvas({ nodes: [], dirs: {}, viewport: VIEWPORT })
    expect(drag('dragOver', pane(), { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(false)
    expect(drag('drop', pane(), { 'text/uri-list': DROP_URL }).defaultPrevented).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(browserNodes()).toHaveLength(0)
  })
})
