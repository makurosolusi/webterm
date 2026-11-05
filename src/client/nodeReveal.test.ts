/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { revealInTabs, revealNode } from './nodeReveal'
import { connectTabLayout, getTabLayout } from './tabLayout.store'
import { toggleFocusedNodeResize } from './nodeResize/nodeResize.store'
import { getNodeResizeState, exitNodeResize } from './nodeResize/nodeResize.store'
import { focusedNodeId } from './presencePing'

const rect = { x: 0, y: 0, width: 100, height: 100 }
const layout = (mode: 'canvas' | 'tabs') => {
  const d = defaultTabLayout()
  return { mode, tabs: { ...d.tabs, order: ['t1', 't2'], active: 't1' } }
}
const rf = (types: Record<string, string>) => ({
  getViewport: () => ({ x: 5000, y: 5000, zoom: 1 }),
  fitView: vi.fn(async () => true),
  getNode: (id: string) => (types[id] ? ({ id, type: types[id] } as never) : undefined),
})

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  document.body.innerHTML = ''
})
afterEach(() => { vi.unstubAllGlobals(); connectTabLayout(undefined, null); exitNodeResize() })

describe('revealNode', () => {
  it('canvas mode: fits the view (node off-screen) and focuses the canvas wrapper', () => {
    connectTabLayout(layout('canvas'), null)
    document.body.innerHTML = '<div class="react-flow__node" data-id="t2" tabindex="0"></div>'
    const r = rf({ t2: 'terminal' })
    revealNode(r, 't2', rect)
    expect(r.fitView).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.getAttribute('data-id')).toBe('t2')
    expect(getTabLayout().tabs.active).toBe('t1')
  })

  it('tab mode: activates the tab, never fitView, focuses the pane', () => {
    connectTabLayout(layout('tabs'), null)
    document.body.innerHTML = '<div class="react-flow__node" data-id="t2"></div><div data-tab-node="" data-id="t2"></div>'
    const r = rf({ t2: 'terminal' })
    revealNode(r, 't2', rect)
    expect(r.fitView).not.toHaveBeenCalled()
    expect(getTabLayout().tabs.active).toBe('t2')
    expect(document.activeElement?.hasAttribute('data-tab-node')).toBe(true)
  })

  it('tab mode: a Files node opens the Files panel and leaves the active tab alone', () => {
    const l = layout('tabs'); l.tabs.filesPanel.open = false
    connectTabLayout(l, null)
    const r = rf({ f1: 'files' })
    revealNode(r, 'f1', rect)
    expect(r.fitView).not.toHaveBeenCalled()
    expect(getTabLayout().tabs.filesPanel.open).toBe(true)
    expect(getTabLayout().tabs.active).toBe('t1')
  })

  it('tab mode: an unknown node kind is treated as a tab (revealInTabs without kind)', () => {
    connectTabLayout(layout('tabs'), null)
    revealInTabs('t2')
    expect(getTabLayout().tabs.active).toBe('t2')
  })

  it('tab mode: a null rf still activates the tab', () => {
    connectTabLayout(layout('tabs'), null)
    revealNode(null, 't2', rect)
    expect(getTabLayout().tabs.active).toBe('t2')
  })
})

describe('tab mode side effects', () => {
  it('resize mode cannot be entered in tab mode (it would rewrite the canvas size)', () => {
    connectTabLayout(layout('tabs'), null)
    document.body.innerHTML = '<div data-tab-node="" data-id="t1" tabindex="0"></div>'
    ;(document.querySelector('[data-tab-node]') as HTMLElement).focus()
    toggleFocusedNodeResize([])
    expect(getNodeResizeState().editingId).toBeNull()
    connectTabLayout(layout('canvas'), null)
    toggleFocusedNodeResize([])
    expect(getNodeResizeState().editingId).toBe('t1')
  })

  it('presence: the focused pane wins, else the active tab (canvas selection is hidden)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    connectTabLayout(layout('tabs'), null)
    document.body.innerHTML = '<div class="react-flow__node selected" data-id="sel"></div><div data-tab-node="" data-id="t2" tabindex="0"></div>'
    expect(focusedNodeId()).toBe('t1')
    ;(document.querySelector('[data-tab-node]') as HTMLElement).focus()
    expect(focusedNodeId()).toBe('t2')
    ;(document.activeElement as HTMLElement).blur()
    connectTabLayout(layout('canvas'), null)
    expect(focusedNodeId()).toBe('sel')
  })
})
