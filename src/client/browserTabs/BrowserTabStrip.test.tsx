/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import { fakeOverflow, makeState, makeTab, renderStrip } from './browserTabsHarness'

const tabs = () => screen.getAllByRole('tab')
const tab = (id: string) => tabs().find((t) => t.getAttribute('data-tab-id') === id) as HTMLElement

describe('BrowserTabStrip ARIA', () => {
  it('renders a tablist of tabs with aria-selected and a roving tabindex', () => {
    renderStrip(makeState(['a', 'b', 'c'], { activeTabId: 'b' }), { panelId: 'panel-1' })
    expect(screen.getByRole('tablist', { name: 'Browser tabs' }).getAttribute('aria-orientation')).toBe('horizontal')
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1])
    expect(tab('b').getAttribute('aria-controls')).toBe('panel-1')
    expect(tab('b').id).toBe('bt-tab-b')
  })

  it('names a tab by title and status, and falls back to host / New tab', () => {
    renderStrip(makeState([], {
      tabs: [
        makeTab('a', { loading: true }), makeTab('b', { crashed: true }), makeTab('c', { discarded: true }),
        makeTab('d', { title: '', url: 'about:blank' }), makeTab('e', { title: '', url: 'https://host.test/x' }),
      ],
      activeTabId: 'a', agentTabId: 'a',
    }), { agentActive: true })
    expect(tab('a').getAttribute('aria-label')).toBe('Title a, loading, agent working here')
    expect(tab('b').getAttribute('aria-label')).toBe('Title b, crashed')
    expect(tab('c').getAttribute('aria-label')).toBe('Title c, sleeping, reloads when opened')
    expect(tab('d').getAttribute('aria-label')).toBe('New tab')
    expect(tab('e').getAttribute('aria-label')).toBe('host.test')
  })

  it('keeps the only tab-order stop on the first tab when nothing is active', () => {
    renderStrip(makeState(['a', 'b'], { activeTabId: null }))
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1])
  })
})

describe('BrowserTabStrip keyboard', () => {
  it('arrows, Home and End move focus (wrapping) without activating', () => {
    const { onAction } = renderStrip(makeState(['a', 'b', 'c']))
    tab('a').focus()
    fireEvent.keyDown(tab('a'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('b'))
    expect(tab('b').tabIndex).toBe(0)
    expect(tab('a').tabIndex).toBe(-1)
    fireEvent.keyDown(tab('b'), { key: 'End' })
    expect(document.activeElement).toBe(tab('c'))
    fireEvent.keyDown(tab('c'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('a'))
    fireEvent.keyDown(tab('a'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tab('c'))
    fireEvent.keyDown(tab('c'), { key: 'Home' })
    expect(document.activeElement).toBe(tab('a'))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('Enter and Space activate the focused tab', () => {
    const { onAction } = renderStrip(makeState(['a', 'b']))
    fireEvent.keyDown(tab('b'), { key: 'Enter' })
    fireEvent.keyDown(tab('b'), { key: ' ' })
    expect(onAction.mock.calls).toEqual([[{ type: 'activate', tabId: 'b' }], [{ type: 'activate', tabId: 'b' }]])
  })

  it('Delete and Ctrl+W close the focused tab and focus its neighbour', () => {
    const { onAction } = renderStrip(makeState(['a', 'b', 'c']))
    tab('b').focus()
    fireEvent.keyDown(tab('b'), { key: 'Delete' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'close', tabId: 'b' })
    expect(document.activeElement).toBe(tab('c'))
    fireEvent.keyDown(tab('a'), { key: 'w', ctrlKey: true })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'close', tabId: 'a' })
  })

  it('Alt+Shift+arrows reorder by one slot', () => {
    const { onAction } = renderStrip(makeState(['a', 'b', 'c']))
    fireEvent.keyDown(tab('b'), { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'reorder', tabId: 'b', toIndex: 0 })
    fireEvent.keyDown(tab('b'), { key: 'ArrowRight', altKey: true, shiftKey: true })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'reorder', tabId: 'b', toIndex: 2 })
  })

  it('opens the context menu from the Menu key and Shift+F10', () => {
    renderStrip(makeState(['a', 'b']))
    fireEvent.keyDown(tab('a'), { key: 'ContextMenu' })
    expect(screen.getByRole('menu', { name: 'Tab actions' })).toBeTruthy()
  })
})

describe('BrowserTabStrip tab visuals', () => {
  it('shows spinner instead of favicon, crashed and discarded icons, favicon, globe', () => {
    renderStrip(makeState([], {
      tabs: [
        makeTab('a', { loading: true, favicon: 'data:image/png;base64,AA==' }), makeTab('b', { crashed: true }),
        makeTab('c', { discarded: true }), makeTab('d', { favicon: 'data:image/png;base64,AA==' }), makeTab('e'),
      ],
      activeTabId: 'e',
    }))
    const icon = (id: string) => tab(id).querySelector('[data-icon]')?.getAttribute('data-icon')
    expect(['a', 'b', 'c', 'd', 'e'].map(icon)).toEqual(['loading', 'crashed', 'discarded', 'favicon', 'globe'])
    fireEvent.error(tab('d').querySelector('img') as HTMLElement)
    expect(icon('d')).toBe('globe')
  })

  it('marks the agent tab with a bot and nothing else', () => {
    renderStrip(makeState(['a', 'b', 'c'], { agentTabId: 'c' }), { agentActive: true })
    expect(tabs().map((t) => t.querySelector('[data-agent-marker]') !== null)).toEqual([false, false, true])
    expect(tab('c').getAttribute('data-agent')).toBe('true')
  })

  it('the agent flag on a tab also shows the marker while the agent holds the browser', () => {
    renderStrip(makeState([], { tabs: [makeTab('a', { agent: true }), makeTab('b')], activeTabId: 'a', agentTabId: null }), { agentActive: true })
    expect(tab('a').querySelector('[data-agent-marker]')).not.toBeNull()
  })

  it('a tab whose title is just its URL shows the host', () => {
    renderStrip(makeState([], { tabs: [makeTab('a', { title: 'https://www.google.com/search?q=x', url: 'https://www.google.com/search?q=x' })] }))
    expect(tab('a').getAttribute('aria-label')).toBe('www.google.com')
  })

  it('a node the human opened shows no marker, although agentTabId defaults to its first tab', () => {
    renderStrip(makeState(['a', 'b'])) // agentTabId = 'a', no lease
    expect(document.querySelector('[data-agent-marker]')).toBeNull()
    expect(tab('a').getAttribute('data-agent')).toBeNull()
    expect(tab('a').getAttribute('aria-label')).toBe('Title a')
  })

  it('every tab has a close button with a named target', () => {
    const { onAction } = renderStrip(makeState(['a', 'b']))
    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ type: 'close', tabId: 'b' })
  })

  it('clicking a tab activates it', () => {
    const { onAction } = renderStrip(makeState(['a', 'b']))
    fireEvent.click(tab('b'))
    expect(onAction).toHaveBeenCalledWith({ type: 'activate', tabId: 'b' })
  })
})

describe('BrowserTabStrip new tab and the limit', () => {
  it('+ opens a new tab with a stamped id', () => {
    const { onAction } = renderStrip(makeState(['a']))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(onAction).toHaveBeenCalledWith({ type: 'new', newTabId: 'new1', afterTabId: undefined })
  })

  it('at 8 tabs + is disabled and the reason is visible', () => {
    const { onAction } = renderStrip(makeState(Array.from({ length: MAX_TABS_PER_NODE }, (_, i) => `t${i}`)))
    const plus = screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement
    expect(plus.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Tab limit (8) reached')
    expect(screen.getByText('8/8')).toBeTruthy()
    fireEvent.click(plus)
    expect(onAction).not.toHaveBeenCalled()
  })

  it('no limit badge below the limit', () => {
    renderStrip(makeState(['a', 'b']))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('BrowserTabStrip overflow', () => {
  it('shows no chevrons or All tabs while everything fits', () => {
    renderStrip(makeState(['a', 'b']))
    expect(screen.queryByRole('button', { name: 'All tabs' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
  })

  it('shows chevrons that scroll and enable by edge, plus an All tabs menu that activates', () => {
    const { onAction } = renderStrip(makeState(['a', 'b', 'c'], { activeTabId: 'a' }))
    const list = screen.getByRole('tablist')
    const scrollBy = vi.fn()
    list.scrollBy = scrollBy as unknown as typeof list.scrollBy
    act(() => { fakeOverflow(list, 900, 300, 0); fireEvent.scroll(list) })
    // A disabled IconButton sits in a wrapper span, so the element is replaced when it enables: query every time.
    const chev = (dir: 'left' | 'right') => screen.getByRole('button', { name: `Scroll tabs ${dir}` }) as HTMLButtonElement
    expect([chev('left').disabled, chev('right').disabled]).toEqual([true, false])
    fireEvent.click(chev('right'))
    expect(scrollBy).toHaveBeenCalledWith({ left: 180, behavior: 'smooth' })
    act(() => { fakeOverflow(list, 900, 300, 600); fireEvent.scroll(list) })
    expect([chev('left').disabled, chev('right').disabled]).toEqual([false, true])
    fireEvent.click(chev('left'))
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -180, behavior: 'smooth' })

    fireEvent.click(screen.getByRole('button', { name: 'All tabs' }))
    const menu = screen.getByRole('menu', { name: 'All tabs' })
    expect(within(menu).getAllByRole('menuitemcheckbox').map((i) => i.textContent)).toEqual(['Title a', 'Title b', 'Title c'])
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Title a' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Title c' }))
    expect(onAction).toHaveBeenCalledWith({ type: 'activate', tabId: 'c' })
  })

  it('scrolls instantly under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    try {
      renderStrip(makeState(['a', 'b']))
      const list = screen.getByRole('tablist')
      const scrollBy = vi.fn()
      list.scrollBy = scrollBy as unknown as typeof list.scrollBy
      act(() => { fakeOverflow(list, 900, 300, 0); fireEvent.scroll(list) })
      fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
      expect(scrollBy).toHaveBeenCalledWith({ left: 180, behavior: 'auto' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
