/** @vitest-environment jsdom */
// Browser node with tabs: the strip, the tabpanel, the tabs REST calls and WS events, shortcuts and limits.
// WS client and REST are faked; the real strip drawing, drag and focus need a real browser.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg, ServerMsg } from '../shared/browser.contract'
import type { BrowserTabEvent, BrowserTabsState } from '../shared/browser.tabs'
import type { BrowserListener } from './browser.stream'
import { BrowserApiError } from './browser.api'
import { makeState, makeTab } from './browserTabs/browserTabsHarness'

const h = vi.hoisted(() => {
  const state = { listener: null as null | BrowserListener, sent: [] as ClientMsg[] }
  const api = {
    list: vi.fn(), create: vi.fn(), activate: vi.fn(), close: vi.fn(), move: vi.fn(), duplicate: vi.fn(), popOut: vi.fn(), reopen: vi.fn(),
  }
  return {
    state, api, showNotice: vi.fn(),
    stream: {
      subscribe: (_id: string, l: BrowserListener) => { state.listener = l; return () => undefined },
      attach: () => undefined, resize: () => undefined, detach: () => undefined, reset: () => undefined,
      send: (m: ClientMsg) => { state.sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: h.stream }))
vi.mock('./browserTabs/browserTabs.api', () => ({ tabsApi: h.api }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: h.showNotice, closeNotice: vi.fn() }))

import BrowserNode from './BrowserNode'

class FakeRO { observe() {} disconnect() {} }

const mount = (extra: Partial<ComponentProps<typeof BrowserNode>> = {}) => render(
  <ReactFlowProvider>
    <BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false, ...extra } as unknown as ComponentProps<typeof BrowserNode>)} />
  </ReactFlowProvider>,
)
const msg = (m: ServerMsg) => act(() => h.state.listener?.onMsg(m))
const tabsMsg = (s: BrowserTabsState) => msg({ t: 'tabs', id: 'b1', state: s })
const tabEvent = (event: BrowserTabEvent) => msg({ t: 'tab', id: 'b1', event })
const tabEls = () => screen.getAllByRole('tab')
const tabEl = (id: string) => tabEls().find((t) => t.getAttribute('data-tab-id') === id) as HTMLElement
const selected = () => tabEls().filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-tab-id'))
const wsSent = (t: string) => h.state.sent.filter((m) => m.t === t)
const view = (ids: string[], over: Partial<BrowserTabsState> = {}) => makeState(ids, over)
const ok = (s: BrowserTabsState, extra = {}) => Promise.resolve({ state: s, ...extra })

beforeEach(() => {
  h.state.listener = null; h.state.sent = []
  for (const f of Object.values(h.api)) f.mockReset()
  h.showNotice.mockReset()
  vi.stubGlobal('ResizeObserver', FakeRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('tab strip on the node', () => {
  it('shows the tabs the server sent and marks the active one as the tabpanel label', () => {
    mount()
    tabsMsg(view(['a', 'b', 'c'], { activeTabId: 'b' }))
    expect(tabEls().map((t) => t.getAttribute('data-tab-id'))).toEqual(['a', 'b', 'c'])
    expect(selected()).toEqual(['b'])
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabEl('b').id)
    expect(tabEl('b').getAttribute('aria-controls')).toBe(panel.id)
  })

  it('a node without tab data shows its page as one tab plus the new-tab button', () => {
    mount()
    msg({ t: 'state', id: 'b1', url: 'https://old.test/', title: 'Old page', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
    expect(tabEls()).toHaveLength(1)
    expect(tabEls()[0].getAttribute('aria-label')).toContain('Old page')
    expect((screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clicking a tab POSTs activate and switches optimistically', async () => {
    mount()
    tabsMsg(view(['a', 'b']))
    h.api.activate.mockImplementation(() => ok(view(['a', 'b'], { activeTabId: 'b' })))
    fireEvent.click(tabEl('b'))
    expect(selected()).toEqual(['b'])
    expect(h.api.activate).toHaveBeenCalledWith('b1', 'b')
  })

  it('the + button POSTs a new tab and shows what the server answered', async () => {
    mount()
    tabsMsg(view(['a']))
    h.api.create.mockImplementation(() => ok(view(['a', 's9'], { activeTabId: 's9' })))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(h.api.create).toHaveBeenCalledWith('b1', {})
    await waitFor(() => expect(selected()).toEqual(['s9']))
  })

  it('closing the active tab DELETEs it and activates the right neighbour', async () => {
    mount()
    tabsMsg(view(['a', 'b', 'c'], { activeTabId: 'b' }))
    h.api.close.mockImplementation(() => ok(view(['a', 'c'], { activeTabId: 'c' })))
    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))
    expect(h.api.close).toHaveBeenCalledWith('b1', 'b')
    expect(selected()).toEqual(['c'])
  })

  it('a failed close restores the strip and says why', async () => {
    mount()
    tabsMsg(view(['a', 'b']))
    h.api.close.mockRejectedValue(new BrowserApiError('boom', 500, 'http_500'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))
    expect(tabEls()).toHaveLength(1)
    await waitFor(() => expect(tabEls()).toHaveLength(2))
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ severity: 'error', title: expect.stringContaining('Could not close the tab') }))
  })

  it('keyboard reorder (Alt+Shift+Arrow) POSTs move with the target index', () => {
    mount()
    tabsMsg(view(['a', 'b', 'c']))
    h.api.move.mockImplementation(() => ok(view(['b', 'a', 'c'])))
    tabEl('a').focus()
    fireEvent.keyDown(tabEl('a'), { key: 'ArrowRight', altKey: true, shiftKey: true })
    expect(h.api.move).toHaveBeenCalledWith('b1', 'a', 1)
    expect(tabEls().map((t) => t.getAttribute('data-tab-id'))).toEqual(['b', 'a', 'c'])
  })

  it('pop out removes the tab and tells the user the node was added server-side on the same profile', async () => {
    mount()
    tabsMsg(view(['a', 'b']))
    h.api.popOut.mockImplementation(() => ok(view(['a']), { newNodeId: 'n2' }))
    fireEvent.contextMenu(tabEl('b'), { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pop out to its own node' }))
    expect(h.api.popOut).toHaveBeenCalledWith('b1', 'b')
    expect(tabEls()).toHaveLength(1)
    await waitFor(() => expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ title: 'Tab opened in its own browser node' })))
  })

  it('a legacy popup message no longer changes anything', () => {
    mount()
    tabsMsg(view(['a']))
    msg({ t: 'popup', id: 'b1', url: 'https://ads.test/' } as ServerMsg)
    expect(tabEls()).toHaveLength(1)
    expect(h.api.create).not.toHaveBeenCalled()
  })
})

describe('events and follow-the-agent', () => {
  it('folds tab events and follows the agent until the human picks a tab', () => {
    mount()
    tabsMsg(view(['a', 'b', 'c']))
    tabEvent({ type: 'tabActivated', nodeId: 'b1', tabId: 'b', by: 'agent' })
    expect(selected()).toEqual(['b'])
    h.api.activate.mockImplementation(() => ok(view(['a', 'b', 'c'], { activeTabId: 'c' })))
    fireEvent.click(tabEl('c'))
    tabEvent({ type: 'tabActivated', nodeId: 'b1', tabId: 'a', by: 'agent' })
    expect(selected()).toEqual(['c'])
    // The server's agentTabId follows the agent, but a human-held node shows no marker (the lease decides).
    expect(tabEl('a').querySelector('[data-agent-marker]')).toBeNull()
    msg({ t: 'state', id: 'b1', url: 'https://old.test/', title: 'Old page', loading: false, canBack: false, canForward: false, lease: 'agent', live: 'live' })
    expect(tabEl('a').querySelector('[data-agent-marker]')).not.toBeNull()
    expect(tabEl('b').querySelector('[data-agent-marker]')).toBeNull()
    msg({ t: 'state', id: 'b1', url: 'https://old.test/', title: 'Old page', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
    expect(tabEl('a').querySelector('[data-agent-marker]')).toBeNull() // lease released: marker gone
  })

  it('applies created and updated events', () => {
    mount()
    tabsMsg(view(['a']))
    tabEvent({ type: 'tabCreated', nodeId: 'b1', tab: makeTab('z', { title: 'Zed' }) })
    tabEvent({ type: 'tabUpdated', nodeId: 'b1', tabId: 'z', patch: { title: 'Zed 2' } })
    expect(tabEl('z').getAttribute('aria-label')).toContain('Zed 2')
  })

  it('shows a server tab notice as a toast', () => {
    mount()
    msg({ t: 'tabNotice', id: 'b1', message: 'Tab limit (8) reached; link opened here' })
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), { severity: 'warning', title: 'Tab limit (8) reached; link opened here' })
  })

  it('keeps the last tab state and shows the reconnecting marker when the socket drops', () => {
    mount()
    tabsMsg(view(['a', 'b']))
    act(() => h.state.listener?.onConnection(false))
    expect(tabEls()).toHaveLength(2)
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })
})

describe('limits', () => {
  it('tab_limit toasts the reason', async () => {
    mount()
    tabsMsg(view(['a']))
    h.api.create.mockRejectedValue(new BrowserApiError('x', 409, 'tab_limit'))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await waitFor(() => expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), { severity: 'warning', title: 'Tab limit (8) reached' }))
  })

  it('at 8 tabs the + button is disabled with the reason and nothing is requested', () => {
    mount()
    tabsMsg(view(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']))
    const plus = screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement
    expect(plus.disabled || plus.getAttribute('aria-disabled') === 'true').toBe(true)
    expect(screen.getByText('Tab limit (8) reached')).toBeTruthy()
    fireEvent.keyDown(tabEl('a'), { key: 't', code: 'KeyT', ctrlKey: true })
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), { severity: 'warning', title: 'Tab limit (8) reached' })
  })

  it('max_live toasts a clear message', async () => {
    mount()
    tabsMsg(view(['a']))
    h.api.create.mockRejectedValue(new BrowserApiError('x', 409, 'max_live'))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await waitFor(() => expect(h.showNotice).toHaveBeenCalledWith(expect.any(String), { severity: 'warning', title: 'Too many browsers are active. Hide one first.' }))
  })
})

describe('active tab owns the page', () => {
  const omnibox = () => ({ renderToolbar: (ctx: { nav: (a: 'go', u: string) => void }) => (
    <form onSubmit={(e) => { e.preventDefault(); ctx.nav('go', 'https://next.test/') }}>
      <input data-browser-omnibox aria-label="Address" /><button type="submit">Go</button>
    </form>
  ) } as Partial<ComponentProps<typeof BrowserNode>>)

  it('the omnibox navigates the active tab through the node channel, not the tab endpoints', () => {
    mount(omnibox())
    tabsMsg(view(['a', 'b'], { activeTabId: 'b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(wsSent('nav')).toEqual([{ t: 'nav', id: 'b1', action: 'go', url: 'https://next.test/' }])
    expect(h.api.create).not.toHaveBeenCalled()
    expect(h.api.activate).not.toHaveBeenCalled()
  })

  it('typing in the omnibox is not stolen by tab shortcuts, but Ctrl+T there still opens a tab', () => {
    mount(omnibox())
    tabsMsg(view(['a']))
    h.api.create.mockImplementation(() => ok(view(['a', 'n'])))
    const input = screen.getByLabelText('Address')
    fireEvent.keyDown(input, { key: 't', code: 'KeyT' })
    fireEvent.keyDown(input, { key: '1', code: 'Digit1' })
    expect(h.api.create).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 't', code: 'KeyT', ctrlKey: true })
    expect(h.api.create).toHaveBeenCalledTimes(1)
  })

  it('shortcuts stay out of terminals inside the node and of anything outside it', () => {
    const { container } = mount()
    tabsMsg(view(['a', 'b']))
    const term = document.createElement('div')
    term.className = 'xterm'
    const inner = document.createElement('textarea')
    term.append(inner)
    container.querySelector('.browser-node')?.append(term)
    fireEvent.keyDown(inner, { key: 't', code: 'KeyT', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 't', code: 'KeyT', ctrlKey: true })
    expect(h.api.create).not.toHaveBeenCalled()
  })

  it('Ctrl+Tab and Ctrl+2 switch tabs from the page surface', () => {
    const { container } = mount()
    tabsMsg(view(['a', 'b', 'c']))
    h.api.activate.mockImplementation(() => ok(view(['a', 'b', 'c'], { activeTabId: 'b' })))
    const sink = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.keyDown(sink, { key: 'Tab', code: 'Tab', ctrlKey: true })
    expect(h.api.activate).toHaveBeenLastCalledWith('b1', 'b')
    fireEvent.keyDown(sink, { key: '3', code: 'Digit3', ctrlKey: true })
    expect(h.api.activate).toHaveBeenLastCalledWith('b1', 'c')
  })

  it('a blank tab beside others opens the new-tab page; submitting navigates that tab', () => {
    mount()
    tabsMsg(view(['a', 'b'], { tabs: [makeTab('a'), makeTab('b', { url: 'about:blank', title: '' })], activeTabId: 'b' }))
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(wsSent('nav')).toEqual([{ t: 'nav', id: 'b1', action: 'go', url: 'https://example.com' }])
  })

  it('a crashed active tab shows Reload, which reloads through the node channel', () => {
    mount()
    tabsMsg(view(['a', 'b'], { tabs: [makeTab('a'), makeTab('b', { crashed: true })], activeTabId: 'b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(wsSent('nav')).toEqual([{ t: 'nav', id: 'b1', action: 'reload' }])
  })
})
