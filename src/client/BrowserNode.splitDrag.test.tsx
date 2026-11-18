/** @vitest-environment jsdom */
// Dragging on the browser node in split view: a tab from the strip onto a pane edge (drop zones + preview), onto a pane's
// middle, and a pane header onto another pane (swap). jsdom has no hit testing or layout: `elementFromPoint` and pane
// rectangles are stubbed, so these prove the wiring and the decisions, not the pixels (see docs/decisions/browser-split.md).
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg, ServerMsg } from '../shared/browser.contract'
import type { BrowserTabsState } from '../shared/browser.tabs'
import type { Pane } from '../shared/workspace.shape'
import type { BrowserListener } from './browser.stream'
import { makeState } from './browserTabs/browserTabsHarness'

const h = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener }
  const api = { list: vi.fn(), create: vi.fn(), activate: vi.fn(), close: vi.fn(), move: vi.fn(), duplicate: vi.fn(), popOut: vi.fn(), reopen: vi.fn(), layout: vi.fn(), device: vi.fn() }
  return {
    state, api,
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, detach: () => undefined, reset: () => undefined, send: (_m: ClientMsg) => undefined,
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: h.stream }))
vi.mock('./browserTabs/browserTabs.api', () => ({ tabsApi: h.api }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: vi.fn(), closeNotice: vi.fn() }))

import BrowserNode from './BrowserNode'

class FakeRO { observe() {} disconnect() {} }
const mount = () => render(<ReactFlowProvider><BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} /></ReactFlowProvider>)
const tabsMsg = (s: BrowserTabsState) => act(() => h.state.listener?.onMsg({ t: 'tabs', id: 'b1', state: s } as ServerMsg))
const leaf = (id: string): Pane => ({ id })
const cols = (a: string, b: string): Pane => ({ dir: 'h', ratio: 0.5, a: leaf(a), b: leaf(b) })
const ok = (layout?: Pane) => Promise.resolve({ state: makeState(['a', 'b', 'c', 'd'], layout ? { layout } : {}) })
const lastLayout = () => h.api.layout.mock.calls.at(-1) as [string, Pane | null, string | undefined]

/** Pretend `target` is the element under the pointer and occupies 0..400 x 0..200. */
function hover(target: HTMLElement) {
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
}
const dragTab = (tabId: string, to: { x: number; y: number }) => {
  const tab = screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-id') === tabId) as HTMLElement
  fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1 })
}

beforeEach(() => {
  h.state.listener = null
  for (const f of Object.values(h.api)) f.mockReset()
  h.api.layout.mockImplementation((_n: string, layout: Pane | null) => ok(layout ?? undefined))
  vi.stubGlobal('ResizeObserver', FakeRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (document as { elementFromPoint?: unknown }).elementFromPoint })

describe('dragging a tab from the strip onto the page', () => {
  it('previews the half it would take and splits on release at the pane edge', async () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c']))
    hover(screen.getByRole('tabpanel'))
    dragTab('b', { x: 390, y: 100 }) // 10px from the right edge of a 400px pane
    const preview = document.querySelector<HTMLElement>('.bp-drop')
    expect(preview?.dataset.zone).toBe('right')
    expect(preview?.style.left).toBe('50%')
    fireEvent.pointerUp(window, { pointerId: 1 })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout().slice(1)).toEqual([cols('a', 'b'), 'b'])
    expect(document.querySelector('.bp-drop')).toBeNull()
  })

  it('the top and left edges put the dropped tab first', async () => {
    mount()
    tabsMsg(makeState(['a', 'b']))
    hover(screen.getByRole('tabpanel'))
    dragTab('b', { x: 10, y: 100 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols('b', 'a'))
  })

  it('dropping in the middle of a pane in a split shows that tab in the pane', async () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c'], { layout: cols('a', 'b') }))
    hover(screen.getByRole('group', { name: 'Pane: Title b' }))
    dragTab('c', { x: 200, y: 100 })
    expect(document.querySelector<HTMLElement>('.bp-drop')?.dataset.zone).toBe('center')
    fireEvent.pointerUp(window, { pointerId: 1 })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout().slice(1)).toEqual([cols('a', 'c'), 'c'])
  })

  it('a tab already on screen moves instead of duplicating: its old pane closes first', async () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c'], { layout: { dir: 'h', ratio: 0.5, a: leaf('a'), b: { dir: 'v', ratio: 0.5, a: leaf('b'), b: leaf('c') } } }))
    hover(screen.getByRole('group', { name: 'Pane: Title a' }))
    dragTab('c', { x: 200, y: 195 }) // bottom edge of pane a
    fireEvent.pointerUp(window, { pointerId: 1 })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual({ dir: 'h', ratio: 0.5, a: { dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('c') }, b: leaf('b') })
  })

  it('at four panes a drop on an edge is refused with the limit reason and changes nothing', async () => {
    mount()
    const grid: Pane = { dir: 'v', ratio: 0.5, a: cols('a', 'b'), b: cols('c', 'd') }
    tabsMsg(makeState(['a', 'b', 'c', 'd', 'e'], { layout: grid }))
    hover(screen.getByRole('group', { name: 'Pane: Title a' }))
    dragTab('e', { x: 395, y: 100 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    await act(async () => { await Promise.resolve() })
    expect(h.api.layout).not.toHaveBeenCalled()
  })

  it('no pane under the pointer: the old behaviour (nothing splits)', () => {
    mount()
    tabsMsg(makeState(['a', 'b']))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })
    dragTab('b', { x: 50, y: 10 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(h.api.layout).not.toHaveBeenCalled()
    expect(document.querySelector('.bp-drop')).toBeNull()
  })
})

describe('swapping panes by their headers', () => {
  it('dragging one pane header onto another swaps their tabs', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols('a', 'b') }))
    const a = screen.getByRole('group', { name: 'Pane: Title a' })
    const b = screen.getByRole('group', { name: 'Pane: Title b' })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => b })
    const grip = a.querySelector('[data-pane-grip]') as HTMLElement
    fireEvent.pointerDown(grip, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 80, pointerId: 1 })
    expect(b.querySelector<HTMLElement>('.bp-drop')?.dataset.zone).toBe('center')
    expect(b.querySelector('.bp-drop__label')?.textContent).toBe('Swap')
    fireEvent.pointerUp(window, { pointerId: 1 })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols('b', 'a'))
  })

  it('a press that does not move is just a click: nothing swaps', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols('a', 'b') }))
    const grip = screen.getByRole('group', { name: 'Pane: Title a' }).querySelector('[data-pane-grip]') as HTMLElement
    fireEvent.pointerDown(grip, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(h.api.layout).not.toHaveBeenCalled()
  })

  it('pressing a header button (title, device, close) does not start a drag', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols('a', 'b') }))
    const btn = within(screen.getByRole('group', { name: 'Pane: Title a' })).getByRole('button', { name: 'Close pane' })
    fireEvent.pointerDown(btn, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 80, pointerId: 1 })
    expect(document.querySelector('.bp-drop')).toBeNull()
  })
})
