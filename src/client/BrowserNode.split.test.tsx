/** @vitest-environment jsdom */
// Split view on the browser node: the pane tree, the Split menu, separators, pane header actions, shortcuts and the
// messages that tell the server what is on screen. WS client and REST are faked; the real look, drag and drop zones
// and pixel sizes need a real browser (see docs/decisions/browser-split.md).
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
  const state = { listener: null as null | BrowserListener, sent: [] as ClientMsg[] }
  const api = { list: vi.fn(), create: vi.fn(), activate: vi.fn(), close: vi.fn(), move: vi.fn(), duplicate: vi.fn(), popOut: vi.fn(), reopen: vi.fn(), layout: vi.fn(), device: vi.fn() }
  return {
    state, api, showNotice: vi.fn(),
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, setAudio: () => undefined, detach: () => undefined, reset: () => undefined,
      send: (m: ClientMsg) => { state.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: h.stream }))
vi.mock('./browserTabs/browserTabs.api', () => ({ tabsApi: h.api }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: h.showNotice, closeNotice: vi.fn() }))

import BrowserNode from './BrowserNode'

class FakeRO { observe() {} disconnect() {} }
const mount = () => render(<ReactFlowProvider><BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} /></ReactFlowProvider>)
const msg = (m: ServerMsg) => act(() => h.state.listener?.onMsg(m))
const tabsMsg = (s: BrowserTabsState) => msg({ t: 'tabs', id: 'b1', state: s })
const sent = (t: string) => h.state.sent.filter((m) => m.t === t)
const leaf = (id: string): Pane => ({ id })
const cols = (a: string, b: string, ratio = 0.5): Pane => ({ dir: 'h', ratio, a: leaf(a), b: leaf(b) })
const grid4: Pane = { dir: 'v', ratio: 0.5, a: cols('a', 'b'), b: cols('c', 'd') }
const split = (ids: string[], layout: Pane | undefined, active = ids[0]) => makeState(ids, { activeTabId: active, ...(layout ? { layout } : {}) })
const ok = (s: BrowserTabsState, extra = {}) => Promise.resolve({ state: s, ...extra })
const openMenu = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))
/** A menu row: items with a check mark are menuitemcheckbox, so match the role prefix. */
const item = (name: RegExp): HTMLElement => {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find((e) => name.test(e.textContent ?? ''))
  if (!row) throw new Error(`no menu row matching ${String(name)}`)
  return row
}
/** ResizeObserver that reports one fixed size on observe (the node and its panes). */
const sizedRO = (w: number, h: number) => class { constructor(private cb: (e: unknown[]) => void) {} observe() { this.cb([{ contentRect: { width: w, height: h } }]) } disconnect() {} }
const lastLayoutCall = () => h.api.layout.mock.calls.at(-1) as [string, Pane | null, string | undefined]

beforeEach(() => {
  h.state.listener = null; h.state.sent = []
  for (const f of Object.values(h.api)) f.mockReset()
  h.api.layout.mockImplementation((_n: string, layout: Pane | null) => ok(split(['a', 'b', 'c', 'd'], layout ?? undefined)))
  h.showNotice.mockReset()
  vi.stubGlobal('ResizeObserver', FakeRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('rendering', () => {
  it('a node without a layout is one page: no pane tree, nothing about panes in the DOM', () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined))
    expect(screen.queryByRole('group', { name: 'Browser panes' })).toBeNull()
    expect(screen.queryAllByRole('separator', { name: /Resize panes/ })).toHaveLength(0)
  })

  it('a saved layout is restored as panes: one per leaf, the active tab focused (aria-current)', () => {
    mount()
    tabsMsg(split(['a', 'b', 'c'], cols('a', 'c'), 'c'))
    const tree = screen.getByRole('group', { name: 'Browser panes' })
    const panes = within(tree).getAllByRole('group').filter((g) => g.hasAttribute('data-pane-tab'))
    expect(panes.map((p) => p.getAttribute('data-pane-tab'))).toEqual(['a', 'c'])
    expect(panes.map((p) => p.getAttribute('aria-current'))).toEqual([null, 'true'])
    expect(panes[0].getAttribute('aria-label')).toBe('Pane: Title a')
  })

  it('a pane whose tab crashed shows the reload state, others stay untouched', () => {
    mount()
    const s = split(['a', 'b'], cols('a', 'b'))
    s.tabs[1] = { ...s.tabs[1], crashed: true }
    tabsMsg(s)
    expect(screen.getAllByRole('alert', { name: 'Tab crashed' })).toHaveLength(1)
  })

  it('the layout comes from the server events too (layoutChanged), and null returns to one page', () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined))
    msg({ t: 'tab', id: 'b1', event: { type: 'layoutChanged', nodeId: 'b1', layout: cols('a', 'b') } })
    expect(screen.getByRole('group', { name: 'Browser panes' })).toBeTruthy()
    msg({ t: 'tab', id: 'b1', event: { type: 'layoutChanged', nodeId: 'b1', layout: null } })
    expect(screen.queryByRole('group', { name: 'Browser panes' })).toBeNull()
  })
})

describe('telling the server what is on screen', () => {
  it('sends the on-screen tabs and the focus, again when they change', () => {
    mount()
    tabsMsg(split(['a', 'b', 'c'], cols('a', 'b')))
    expect(sent('view').at(-1)).toMatchObject({ t: 'view', visible: ['a', 'b'], focus: 'a' })
    msg({ t: 'tab', id: 'b1', event: { type: 'tabActivated', nodeId: 'b1', tabId: 'b', by: 'human' } })
    expect(sent('view').at(-1)).toMatchObject({ visible: ['a', 'b'], focus: 'b' })
  })
  it('a single page reports itself alone', () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined, 'b'))
    expect(sent('view').at(-1)).toMatchObject({ visible: ['b'], focus: 'b' })
  })
  it('a pane tags its input with its tab', () => {
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    const surfaces = screen.getAllByLabelText('Browser keyboard input')
    fireEvent.input(surfaces[1], { target: { value: 'x' } })
    fireEvent.paste(surfaces[1].parentElement as HTMLElement, { clipboardData: { getData: () => 'hello' } })
    expect(sent('text').at(-1)).toMatchObject({ text: 'hello', tab: 'b' })
  })
  it('frames of a tagged tab never paint the node canvas and are still acked', async () => {
    vi.stubGlobal('ResizeObserver', sizedRO(400, 300))
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    // (attached via the sized RO above)
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('no decoder'))))
    act(() => h.state.listener?.onFrame(7, new Uint8Array([1]), undefined, 'b'))
    await waitFor(() => expect(sent('ack')).toContainEqual({ t: 'ack', id: 'b1', seq: 7 }))
  })
})

describe('focus', () => {
  it('pressing in another pane activates its tab', () => {
    mount()
    h.api.activate.mockImplementation(() => ok(split(['a', 'b'], cols('a', 'b'), 'b')))
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    fireEvent.pointerDown(screen.getByRole('group', { name: 'Pane: Title b' }))
    expect(h.api.activate).toHaveBeenCalledWith('b1', 'b')
  })
  it('pressing in the focused pane does nothing', () => {
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    fireEvent.pointerDown(screen.getByRole('group', { name: 'Pane: Title a' }))
    expect(h.api.activate).not.toHaveBeenCalled()
  })
})

describe('Split menu', () => {
  it('Split right gives the focused pane a neighbour showing a hidden tab', async () => {
    mount()
    tabsMsg(split(['a', 'b', 'c'], undefined))
    openMenu(/Split view/)
    fireEvent.click(item(/Split right/))
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayoutCall().slice(1)).toEqual([cols('a', 'b'), 'b'])
  })

  it('Split down with no hidden tab opens a new one for the pane', async () => {
    mount()
    h.api.create.mockImplementation(() => ok(split(['a', 'n1'], undefined), { tab: { tabId: 'n1', title: '', url: 'about:blank', loading: false, discarded: false, crashed: false } }))
    tabsMsg(split(['a'], undefined))
    openMenu(/Split view/)
    fireEvent.click(item(/Split down/))
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(h.api.create).toHaveBeenCalled()
    expect(lastLayoutCall().slice(1)).toEqual([{ dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('n1') }, 'n1'])
  })

  it('at four panes the split rows are disabled and say why', () => {
    mount()
    tabsMsg(split(['a', 'b', 'c', 'd'], grid4))
    openMenu(/Split view \(4\/4 panes\)/)
    for (const re of [/Split right/, /Split down/]) {
      const row = item(re)
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.getAttribute('title')).toBe('Pane limit (4) reached')
    }
  })

  it('2 columns, 2 rows and 2×2 build the layouts from the tabs at hand', async () => {
    mount()
    tabsMsg(split(['a', 'b', 'c', 'd'], undefined))
    openMenu(/Split view/)
    fireEvent.click(item(/2 columns/))
    await waitFor(() => expect(lastLayoutCall()[1]).toEqual(cols('a', 'b')))
    openMenu(/Split view/)
    fireEvent.click(item(/2 rows/))
    await waitFor(() => expect(lastLayoutCall()[1]).toEqual({ dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') }))
    openMenu(/Split view/)
    fireEvent.click(item(/2 × 2 grid/))
    await waitFor(() => expect(lastLayoutCall()[1]).toEqual(grid4))
  })

  it('Unsplit returns to one pane and is offered only while split', async () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined))
    openMenu(/Split view/)
    expect(screen.queryByRole('menuitem', { name: /Unsplit/ })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    cleanup()
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    openMenu(/Split view/)
    fireEvent.click(item(/Unsplit/))
    await waitFor(() => expect(lastLayoutCall()[1]).toBeNull())
  })

  it('"Open this page in 3 sizes" opens the same URL twice more, lays out 3 panes and sets a device on each', async () => {
    mount()
    let n = 0
    h.api.create.mockImplementation(() => { n += 1; return ok(split(['a', 'n1', 'n2'], undefined), { tab: { tabId: `n${n}`, title: '', url: 'https://a.example.com/page', loading: false, discarded: false, crashed: false } }) })
    h.api.device.mockImplementation(() => ok(split(['a', 'n1', 'n2'], undefined)))
    tabsMsg(split(['a'], undefined))
    openMenu(/Split view/)
    fireEvent.click(item(/3 sizes/))
    await waitFor(() => expect(h.api.device).toHaveBeenCalledTimes(3))
    expect(h.api.create.mock.calls.map((c) => (c as [string, { url?: string }])[1].url)).toEqual(['https://a.example.com/page', 'https://a.example.com/page'])
    expect(lastLayoutCall()[1]).toMatchObject({ dir: 'h', a: leaf('a'), b: { a: leaf('n1'), b: leaf('n2') } })
    expect(h.api.device.mock.calls.map((c) => [c[1], (c[2] as { id: string }).id])).toEqual([['a', 'custom'], ['n1', 'ipad-mini'], ['n2', 'desktop-1920']])
  })

  it('"Open this page in 3 sizes" on a blank page asks for a page first', async () => {
    mount()
    tabsMsg(makeState(['a'], { tabs: [{ tabId: 'a', title: '', url: 'about:blank', loading: false, discarded: false, crashed: false }] }))
    openMenu(/Split view/)
    fireEvent.click(item(/3 sizes/))
    await waitFor(() => expect(h.showNotice).toHaveBeenCalled())
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('a node too small for two panes refuses with "Enlarge the node to split"', () => {
    vi.stubGlobal('ResizeObserver', sizedRO(300, 300))
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    const hh = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    try {
      mount()
      tabsMsg(split(['a', 'b'], undefined))
      openMenu(/Split view/)
      expect(item(/Split right/).getAttribute('title')).toBe('Enlarge the node to split')
    } finally {
      w.mockRestore(); hh.mockRestore()
    }
  })
})

describe('pane header', () => {
  it('Close pane collapses the split and keeps the other pane focused', async () => {
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    fireEvent.click(within(screen.getByRole('group', { name: 'Pane: Title b' })).getByRole('button', { name: 'Close pane' }))
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayoutCall().slice(1)).toEqual([null, undefined])
  })

  it('closing the focused pane moves the focus to the one that stays', async () => {
    mount()
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    fireEvent.click(within(screen.getByRole('group', { name: 'Pane: Title a' })).getByRole('button', { name: 'Close pane' }))
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
    expect(lastLayoutCall().slice(1)).toEqual([null, 'b'])
  })

  const pickIn = (paneName: string, then: RegExp) => {
    fireEvent.click(within(screen.getByRole('group', { name: paneName })).getByRole('button', { name: /^Title/ }))
    fireEvent.click(item(then))
  }
  it('picking a hidden tab in a pane shows it there', async () => {
    mount()
    tabsMsg(split(['a', 'b', 'c'], cols('a', 'b')))
    pickIn('Pane: Title b', /Title c/)
    await waitFor(() => expect(lastLayoutCall()[1]).toEqual(cols('a', 'c')))
  })
  it('picking a tab that another pane shows swaps the two panes', async () => {
    mount()
    tabsMsg(split(['a', 'b', 'c'], cols('a', 'b')))
    pickIn('Pane: Title b', /Title a/)
    await waitFor(() => expect(lastLayoutCall()[1]).toEqual(cols('b', 'a')))
  })

  it('the device menu sets a preset on that pane only, with the size shown in the corner', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols('a', 'b'), tabs: [
      { tabId: 'a', title: 'Title a', url: 'https://a.example.com/', loading: false, discarded: false, crashed: false },
      { tabId: 'b', title: 'Title b', url: 'https://b.example.com/', loading: false, discarded: false, crashed: false, device: { id: 'custom', w: 390, h: 844, dpr: 2 } },
    ] }))
    const a = screen.getByRole('group', { name: 'Pane: Title a' })
    const b = screen.getByRole('group', { name: 'Pane: Title b' })
    expect(within(b).getByTestId('pane-size').textContent).toBe('390 × 844')
    fireEvent.click(within(a).getByRole('button', { name: /Device: Responsive/ }))
    expect(Array.from(document.querySelectorAll('[role^="menuitem"]')).map((m) => m.textContent)).toEqual(expect.arrayContaining(['Responsive', 'Mobile 390', 'Tablet 768', 'Laptop 1280', 'Desktop 1920']))
    h.api.device.mockImplementation(() => ok(split(['a', 'b'], cols('a', 'b'))))
    fireEvent.click(item(/Tablet 768/))
    await waitFor(() => expect(h.api.device).toHaveBeenCalledWith('b1', 'a', { id: 'ipad-mini' }))
  })

  it('choosing Responsive clears the device (null)', async () => {
    mount()
    tabsMsg(makeState(['a', 'b'], { layout: cols('a', 'b'), tabs: [
      { tabId: 'a', title: 'Title a', url: 'https://a.example.com/', loading: false, discarded: false, crashed: false, device: { id: 'ipad-mini' } },
      { tabId: 'b', title: 'Title b', url: 'https://b.example.com/', loading: false, discarded: false, crashed: false },
    ] }))
    h.api.device.mockImplementation(() => ok(split(['a', 'b'], cols('a', 'b'))))
    fireEvent.click(within(screen.getByRole('group', { name: 'Pane: Title a' })).getByRole('button', { name: /Device: iPad Mini/ }))
    fireEvent.click(item(/Responsive/))
    await waitFor(() => expect(h.api.device).toHaveBeenCalledWith('b1', 'a', null))
  })
})

describe('shortcuts', () => {
  const key = (init: KeyboardEventInit) => fireEvent.keyDown(screen.getByRole('tabpanel'), init)
  it('Ctrl+\\ splits the focused pane to the right', async () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined))
    key({ key: '\\', code: 'Backslash', ctrlKey: true })
    await waitFor(() => expect(h.api.layout).toHaveBeenCalled())
  })
  it('Ctrl+Alt+Arrow moves the focus between panes', () => {
    mount()
    h.api.activate.mockImplementation(() => ok(split(['a', 'b'], cols('a', 'b'), 'b')))
    tabsMsg(split(['a', 'b'], cols('a', 'b')))
    key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })
    expect(h.api.activate).toHaveBeenCalledWith('b1', 'b')
  })
  it('does not fire from a terminal-like editor inside the node', () => {
    mount()
    tabsMsg(split(['a', 'b'], undefined))
    const x = document.createElement('div')
    x.className = 'xterm'
    const input = document.createElement('textarea')
    x.appendChild(input)
    screen.getByRole('tabpanel').appendChild(x)
    fireEvent.keyDown(input, { key: '\\', code: 'Backslash', ctrlKey: true })
    expect(h.api.layout).not.toHaveBeenCalled()
  })
})
