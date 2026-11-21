/** @vitest-environment jsdom */
// Moving panes in a split browser node: drag a pane header onto another pane (centre = swap, edge = move beside it), abort
// with Escape / pointercancel / a drop outside, the keyboard route (Alt+Shift+Arrow, context menu), the aria-live line, the
// shared drag engine's body flag, and a clean click that never turns into a drag. jsdom has no layout: pane rects are stubbed.
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
      attach: () => undefined, resize: () => undefined, setAudio: () => undefined, detach: () => undefined, reset: () => undefined, send: (_m: ClientMsg) => undefined,
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: h.stream }))
vi.mock('./browserTabs/browserTabs.api', () => ({ tabsApi: h.api }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: vi.fn(), closeNotice: vi.fn() }))

import BrowserNode from './BrowserNode'

class FakeRO { observe() {} disconnect() {} }
const mount = () => render(<ReactFlowProvider><BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} /></ReactFlowProvider>)
let server: BrowserTabsState = makeState(['a', 'b', 'c']) // what the fake server would answer with
const tabsMsg = (s: BrowserTabsState) => { server = s; act(() => h.state.listener?.onMsg({ t: 'tabs', id: 'b1', state: s } as ServerMsg)) }
const leaf = (id: string): Pane => ({ id })
const cols = (a: Pane, b: Pane): Pane => ({ dir: 'h', ratio: 0.5, a, b })
const rows = (a: Pane, b: Pane): Pane => ({ dir: 'v', ratio: 0.5, a, b })
const ok = (layout?: Pane) => { server = { ...server, layout }; return Promise.resolve({ state: server }) }
const lastLayout = () => h.api.layout.mock.calls.at(-1) as [string, Pane | null, string | undefined]
const pane = (t: string) => screen.getByRole('group', { name: `Pane: Title ${t}` })
const grip = (t: string) => pane(t).querySelector('[data-pane-grip]') as HTMLElement

/** `target` is the element under the pointer and occupies 0..400 x 0..200. */
function over(target: HTMLElement) {
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
}
const press = (t: string) => fireEvent.pointerDown(grip(t), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
const moveTo = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 })
const release = () => fireEvent.pointerUp(window, { pointerId: 1 })

beforeEach(() => {
  h.state.listener = null
  for (const f of Object.values(h.api)) f.mockReset()
  h.api.activate.mockImplementation((_n: string, tabId: string) => Promise.resolve({ state: { ...server, activeTabId: tabId } }))
  h.api.layout.mockImplementation((_n: string, layout: Pane | null) => ok(layout ?? undefined))
  vi.stubGlobal('ResizeObserver', FakeRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (document as { elementFromPoint?: unknown }).elementFromPoint })

describe('React Flow must not take the node\'s presses', () => {
  it('the strip and the page body sit inside nodrag nopan (a wobbling click is otherwise swallowed by d3-drag)', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    for (const sel of ['.bt-strip', '.browser-body']) {
      const el = document.querySelector(sel) as HTMLElement
      expect(el.className, sel).toContain('nodrag')
      expect(el.className, sel).toContain('nopan')
    }
  })
})

describe('dragging a pane header', () => {
  it('the header has a grip handle with the tooltip text and is inert to React Flow', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    expect(grip('a').className).toContain('nodrag')
    expect(grip('a').className).toContain('nopan')
    expect(grip('a').querySelector('[data-pane-grip-handle]')).not.toBeNull()
  })

  it('the middle of another pane previews "Swap", lifts the dragged pane and swaps on release', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    over(pane('b'))
    press('a')
    moveTo(200, 100)
    expect(pane('a').className).toContain('bp--lift')
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(true)
    expect(document.querySelector('.bp-ghost')?.textContent).toBe('Title a')
    expect(pane('b').querySelector('.bp-drop__label')?.textContent).toBe('Swap')
    release()
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols(leaf('b'), leaf('a')))
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(false)
    expect(screen.getByTestId('pane-announce').textContent).toBe('Pane 1 swapped with pane 2')
  })

  it('an edge of another pane moves the pane there and says where', async () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c'], { layout: cols(leaf('a'), rows(leaf('b'), leaf('c'))) }))
    over(pane('a'))
    press('c')
    moveTo(5, 100) // left quarter of pane a
    expect(pane('a').querySelector('.bp-drop__label')?.textContent).toBe('Move to left')
    expect(pane('a').querySelector<HTMLElement>('.bp-drop')?.dataset.zone).toBe('left')
    release()
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols(cols(leaf('c'), leaf('a')), leaf('b')))
    expect(screen.getByTestId('pane-announce').textContent).toBe('Pane 1 moved to the left of pane 2')
  })

  it('a press that never passes the threshold is a click: no drag, no body flag, the title menu still opens', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    press('a')
    moveTo(7, 5) // 2px
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(false)
    release()
    expect(h.api.layout).not.toHaveBeenCalled()
    fireEvent.click(within(pane('a')).getByRole('button', { name: /Title a/ }))
    expect(screen.getByRole('menu', { name: 'Tab in this pane' })).toBeTruthy()
  })

  it('the title button starts a drag too, and the click after a drag does not open its menu', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    over(pane('b'))
    const title = within(pane('a')).getByRole('button', { name: /Title a/ })
    fireEvent.pointerDown(title, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    moveTo(200, 100)
    release()
    fireEvent.click(title)
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
  })

  it('the close and device buttons never start a drag', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    fireEvent.pointerDown(within(pane('a')).getByRole('button', { name: 'Close pane' }), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    moveTo(300, 80)
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(false)
  })

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['pointercancel', () => fireEvent.pointerCancel(window, { pointerId: 1 })],
  ])('%s aborts: nothing changes, the lift and the flag are gone', (_n, abort) => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    over(pane('b'))
    press('a')
    moveTo(200, 100)
    act(() => { abort() })
    release()
    expect(h.api.layout).not.toHaveBeenCalled()
    expect(pane('a').className).not.toContain('bp--lift')
    expect(document.querySelector('.bp-drop')).toBeNull()
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(false)
  })

  it('releasing outside every pane, or on the pane itself, changes nothing and previews nothing', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body })
    press('a')
    moveTo(300, 80)
    expect(document.querySelector('.bp-drop')).toBeNull()
    release()
    over(pane('a'))
    press('a')
    moveTo(100, 80)
    expect(document.querySelector('.bp-drop')).toBeNull()
    release()
    expect(h.api.layout).not.toHaveBeenCalled()
  })

  it('a tab dragged from the strip uses the same zones and labels ("Split right" / "Show here")', () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c'], { layout: cols(leaf('a'), leaf('b')) }))
    over(pane('a'))
    const tab = screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-id') === 'c') as HTMLElement
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    moveTo(395, 100)
    expect(pane('a').querySelector('.bp-drop__label')?.textContent).toBe('Split right')
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.hasAttribute('data-bp-dragging')).toBe(false)
    expect(h.api.layout).not.toHaveBeenCalled()
  })
})

describe('moving a pane without a pointer', () => {
  it('Alt+Shift+Arrow swaps with the neighbour that way and announces it', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    fireEvent.keyDown(within(pane('b')).getByRole('button', { name: /Title b/ }), { key: 'ArrowLeft', altKey: true, shiftKey: true })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols(leaf('b'), leaf('a')))
    expect(screen.getByTestId('pane-announce').textContent).toBe('Pane 1 moved to the left')
  })

  it('at the edge of the layout nothing moves and the live region says so', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    fireEvent.keyDown(within(pane('a')).getByRole('button', { name: /Title a/ }), { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(h.api.layout).not.toHaveBeenCalled()
    expect(screen.getByTestId('pane-announce').textContent).toBe('Pane cannot move to the left')
  })

  it('plain arrows and Alt+Arrow do not move panes', () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols(leaf('a'), leaf('b')) }))
    const t = within(pane('b')).getByRole('button', { name: /Title b/ })
    fireEvent.keyDown(t, { key: 'ArrowLeft' })
    fireEvent.keyDown(t, { key: 'ArrowLeft', altKey: true })
    expect(h.api.layout).not.toHaveBeenCalled()
  })

  it('the header context menu offers Move pane left/right/up/down (disabled with no neighbour) and Swap with', async () => {
    mount()
    tabsMsg(makeState(['a', 'b', 'c'], { layout: cols(leaf('a'), rows(leaf('b'), leaf('c'))) }))
    fireEvent.contextMenu(grip('b'), { clientX: 50, clientY: 50 })
    const menu = screen.getByRole('menu', { name: 'Move pane' })
    expect(within(menu).getByRole('menuitem', { name: 'Move pane left' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Move pane right' }).getAttribute('aria-disabled')).toBe('true')
    expect(within(menu).getByRole('menuitem', { name: 'Move pane up' }).getAttribute('aria-disabled')).toBe('true')
    expect(within(menu).getByRole('menuitem', { name: 'Move pane down' }).getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Swap with Title a' }))
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayout()[1]).toEqual(cols(leaf('b'), rows(leaf('a'), leaf('c'))))
  })
})
