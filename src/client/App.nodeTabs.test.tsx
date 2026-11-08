/** @vitest-environment jsdom */
// Node tab strip on the REAL App: shown above the canvas by default, click pans to and selects the
// node, canvas selection highlights the tab, × closes through the node-close confirm, tab mode keeps
// its own strip, and the View toggle hides it.
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import type { WsNode } from '../shared/workspace'
import { confirmNodeCloseDialog, installCanvasDom, mountCanvas, renderedViewport, unmountCanvas } from './canvasHarness'
import { connectTabLayout, setMode } from './tabLayout.store'
import { reloadNodeTabsShown, setNodeTabsShown } from './nodeTabs.visible'

vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: () => undefined }
})
vi.setConfig({ testTimeout: 60_000 })

// test-only fixture: one agent in view, one terminal far off to the right.
const near: WsNode = { id: 'agent-near', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo a', agentId: 'claude', cwd: '/', title: 'near' }
const far: WsNode = { id: 'term-far', kind: 'terminal', x: 9000, y: 6000, width: 420, height: 320, cwd: '/', title: 'far' }

beforeAll(installCanvasDom)
beforeEach(() => { localStorage.clear(); reloadNodeTabsShown(); connectTabLayout(defaultTabLayout(), null) })
afterEach(unmountCanvas)

const strip = () => document.querySelector('.node-tabs [role="tablist"]')
const tab = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.node-tabs [role="tab"]')).find((t) => t.textContent?.includes(title))
const selectedIds = () => Array.from(document.querySelectorAll('.react-flow__node.selected')).map((n) => n.getAttribute('data-id'))

describe('node tab strip on the real App', () => {
  it('is shown by default with one tab per node, above the board', async () => {
    await mountCanvas({ nodes: [near, far], dirs: {} })
    expect(strip()?.getAttribute('aria-label')).toBe('Nodes')
    expect(Array.from(document.querySelectorAll('.node-tabs .tabs-tab__title')).map((t) => t.textContent)).toEqual(['near', 'far'])
    // The board host follows the strip, which is what moves the canvas below it.
    expect(document.querySelector('.node-tabs')?.nextElementSibling?.classList.contains('board-host')).toBe(true)
  })

  it('click selects the node and pans the canvas to it; canvas selection highlights its tab', async () => {
    await mountCanvas({ nodes: [near, far], dirs: {} })
    const before = renderedViewport()
    fireEvent.click(tab('far')!)
    await waitFor(() => expect(selectedIds()).toEqual(['term-far']))
    await waitFor(() => expect(renderedViewport()).not.toEqual(before))
    await waitFor(() => expect(tab('far')?.getAttribute('aria-selected')).toBe('true'))
    expect(tab('near')?.getAttribute('aria-selected')).toBe('false')

    // Selecting on the canvas (a click on the node) moves the highlight to that node's tab.
    const nearEl = document.querySelector<HTMLElement>('.react-flow__node[data-id="agent-near"]')!
    fireEvent.click(nearEl)
    await waitFor(() => expect(tab('near')?.getAttribute('aria-selected')).toBe('true'))
  })

  it('× closes through the node-close confirm', async () => {
    await mountCanvas({ nodes: [near, far], dirs: {} })
    const close = tab('near')!.querySelector<HTMLElement>('button[aria-label="Close near"]')!
    fireEvent.click(close)
    await confirmNodeCloseDialog()
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="agent-near"]')).toBeNull())
    await waitFor(() => expect(tab('near')).toBeUndefined())
    expect(tab('far')).toBeDefined()
  })

  it('tab mode shows its own strip (same component) and no canvas strip', async () => {
    await mountCanvas({ nodes: [near, far], dirs: {} })
    act(() => setMode('tabs'))
    await waitFor(() => expect(document.querySelector('.tabs-view [role="tablist"]')).not.toBeNull())
    expect(document.querySelector('.node-tabs')).toBeNull()
    act(() => setMode('canvas'))
    await waitFor(() => expect(strip()).not.toBeNull())
  })

  it('Show Node Tabs off hides the strip', async () => {
    await mountCanvas({ nodes: [near], dirs: {} })
    act(() => setNodeTabsShown(false))
    await waitFor(() => expect(document.querySelector('.node-tabs')).toBeNull())
    act(() => setNodeTabsShown(true))
    await waitFor(() => expect(strip()).not.toBeNull())
  })
})
