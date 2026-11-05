/** @vitest-environment jsdom */
// Mode switch on the REAL App: canvas <-> tabs must keep every node mounted (same host element, same
// DOM inside it), leave nodes/edges/viewport untouched, and add the one-time Files node on first entry.
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import type { BridgeLink, WsNode } from '../shared/workspace'
import { installCanvasDom, mountCanvas, renderedEdgeIds, renderedViewport, unmountCanvas } from './canvasHarness'
import { getTabLayout, connectTabLayout, setMode } from './tabLayout.store'

vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: () => undefined }
})
vi.setConfig({ testTimeout: 60_000 })

// Agents carry link handles, so their cable renders; the host holds their terminal chrome.
const a: WsNode = { id: 'term-a', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo a', agentId: 'claude', cwd: '/', title: 'a' }
const b: WsNode = { id: 'term-b', kind: 'agent', x: 600, y: 0, width: 420, height: 320, cmd: 'echo b', agentId: 'claude', cwd: '/', title: 'b' }
const cable: BridgeLink = { id: 'bridge-term-a-term-b', source: 'term-a', target: 'term-b', kind: 'context' }
const filesNode: WsNode = { id: 'files-node', kind: 'files', x: 0, y: 400, width: 420, height: 320, dirPath: '/p', title: 'p' }
const VIEWPORT = { x: 40, y: 25, zoom: 0.8 }

beforeAll(installCanvasDom)
beforeEach(() => connectTabLayout(defaultTabLayout(), null))
afterEach(unmountCanvas)

const nodeIds = () => Array.from(document.querySelectorAll('.react-flow__node')).map((n) => n.getAttribute('data-id'))
const nodeBoxes = () => Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map((n) => `${n.dataset.id}:${n.style.transform}`)

describe('tab layout on the real App', () => {
  it('toggling to tabs and back leaves nodes, cables and viewport intact and remounts nothing', async () => {
    // A Files node is already on the board, so entering tabs adds nothing and the node set stays comparable.
    await mountCanvas({ nodes: [a, b, filesNode], bridges: [cable], dirs: {}, viewport: VIEWPORT })
    await waitFor(() => expect(renderedEdgeIds()).toEqual([cable.id]))
    const before = { ids: nodeIds(), boxes: nodeBoxes(), edges: renderedEdgeIds(), vp: renderedViewport() }
    const hosts = Array.from(document.querySelectorAll<HTMLElement>('.tab-host'))
    expect(hosts.length).toBeGreaterThanOrEqual(2)
    // Marker on each host's content: a remount would replace the element and lose it.
    hosts.forEach((h) => { (h.firstElementChild as HTMLElement).dataset.marker = 'same' })

    act(() => setMode('tabs'))
    await waitFor(() => expect(document.querySelector('.tabs-view')).not.toBeNull())
    // Canvas hidden, not unmounted; terminal hosts now live inside the tab panes.
    expect(document.querySelector('.react-flow__pane')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('.board-host')?.dataset.mode).toBe('tabs')
    await waitFor(() => expect(document.querySelectorAll('.tabs-pane .tab-host').length).toBeGreaterThanOrEqual(2))

    act(() => setMode('canvas'))
    await waitFor(() => expect(document.querySelector('.tabs-view')).toBeNull())
    expect(document.querySelector<HTMLElement>('.board-host')?.dataset.mode).toBe('canvas')
    expect(nodeIds()).toEqual(before.ids)
    expect(nodeBoxes()).toEqual(before.boxes)
    expect(renderedEdgeIds()).toEqual(before.edges)
    expect(renderedViewport()).toEqual(before.vp)
    // Same host elements, same content elements (marker survived), back inside the canvas.
    expect(Array.from(document.querySelectorAll('.tab-host'))).toEqual(hosts)
    hosts.forEach((h) => {
      expect((h.firstElementChild as HTMLElement).dataset.marker).toBe('same')
      expect(h.closest('.react-flow__node')).not.toBeNull()
    })
  })

  it('first canvas -> tabs adds one Files node; once closed, later toggles do not bring it back', async () => {
    await mountCanvas({ nodes: [a], dirs: {}, viewport: VIEWPORT })
    expect(document.querySelector('.react-flow__node-files')).toBeNull()

    act(() => setMode('tabs'))
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node-files')).toHaveLength(1))

    // Tab chrome has no close for the Files panel, so the user closes it from the canvas, then re-enters tabs: it stays closed.
    act(() => setMode('canvas'))
    await waitFor(() => expect(document.querySelector('.tabs-view')).toBeNull())
    const close = document.querySelector('.react-flow__node-files button[title^="Close"], .react-flow__node-files vscode-toolbar-button[data-title^="Close"]')
    if (!close) throw new Error('no close button on the Files node')
    fireEvent.click(close)
    await waitFor(() => expect(document.querySelector('.react-flow__node-files')).toBeNull())
    act(() => setMode('tabs'))
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(document.querySelector('.react-flow__node-files')).toBeNull()
    expect(getTabLayout().mode).toBe('tabs')
  })

  it('a board that already has a Files node gets no extra one', async () => {
    await mountCanvas({ nodes: [a, filesNode], dirs: {}, viewport: VIEWPORT })
    act(() => setMode('tabs'))
    await act(() => new Promise<void>((r) => setTimeout(r, 50)))
    expect(document.querySelectorAll('.react-flow__node-files')).toHaveLength(1)
  })

  it('the workspace bar button switches the mode and reflects it', async () => {
    await mountCanvas({ nodes: [a, filesNode], dirs: {}, viewport: VIEWPORT })
    const btn = () => document.querySelector('button[aria-label="Toggle tab layout"]') as HTMLElement
    expect(btn().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn())
    await waitFor(() => expect(getTabLayout().mode).toBe('tabs'))
    expect(btn().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(btn())
    await waitFor(() => expect(getTabLayout().mode).toBe('canvas'))
  })
})
