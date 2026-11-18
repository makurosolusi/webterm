import { describe, expect, it } from 'vitest'
import {
  MAX_CLOSED_HISTORY, MAX_TABS_PER_NODE, MAX_TAB_TITLE_LENGTH, MAX_TAB_URL_LENGTH, TAB_LIMIT_REASON,
  applyTabEvent, canAddTab, emptyTabsState, isBrowserTab, nextActiveAfterClose, newTabId, reduceTabs, reorderTabs,
  sanitizeTabTitle, validateTabUrl, type BrowserTab, type BrowserTabsState,
} from './browser.tabs'

const tab = (tabId: string, extra: Partial<BrowserTab> = {}): BrowserTab =>
  ({ tabId, title: `T ${tabId}`, url: `https://${tabId}.test/`, loading: false, discarded: false, crashed: false, ...extra })
const make = (ids: string[], active: string | null = ids[0] ?? null, agent: string | null = active): BrowserTabsState =>
  ({ tabs: ids.map((i) => tab(i)), activeTabId: active, agentTabId: agent, closed: [] })
const ids = (s: BrowserTabsState) => s.tabs.map((t) => t.tabId)

describe('validators', () => {
  it('accepts http(s), blank and empty; rejects other protocols, bad types, long and control chars', () => {
    expect(validateTabUrl('https://a.test/x')).toEqual({ ok: true, url: 'https://a.test/x' })
    expect(validateTabUrl('  ')).toEqual({ ok: true, url: 'about:blank' })
    expect(validateTabUrl('about:blank')).toEqual({ ok: true, url: 'about:blank' })
    expect(validateTabUrl('javascript:alert(1)')).toMatchObject({ ok: false })
    expect(validateTabUrl('file:///etc/passwd')).toMatchObject({ ok: false })
    expect(validateTabUrl('not a url')).toMatchObject({ ok: false })
    expect(validateTabUrl(42)).toMatchObject({ ok: false, reason: 'URL must be text' })
    expect(validateTabUrl(`https://a.test/${'x'.repeat(MAX_TAB_URL_LENGTH)}`)).toMatchObject({ ok: false })
    expect(validateTabUrl('https://a.test/\u0007')).toMatchObject({ ok: false })
  })
  it('sanitizes titles: type, control chars, length', () => {
    expect(sanitizeTabTitle(null)).toBe('')
    expect(sanitizeTabTitle(' a\nb ')).toBe('a b')
    expect(sanitizeTabTitle('x'.repeat(MAX_TAB_TITLE_LENGTH + 50))).toHaveLength(MAX_TAB_TITLE_LENGTH)
  })
  it('isBrowserTab checks structure', () => {
    expect(isBrowserTab(tab('a', { favicon: 'x' }))).toBe(true)
    expect(isBrowserTab({ ...tab('a'), loading: 'yes' })).toBe(false)
    expect(isBrowserTab({ ...tab('a'), favicon: 1 })).toBe(false)
    expect(isBrowserTab(tab('a', { faviconData: 'data:image/png;base64,AA==' }))).toBe(true)
    expect(isBrowserTab({ ...tab('a'), faviconData: 5 })).toBe(false)
    expect(isBrowserTab({ ...tab(''), tabId: '' })).toBe(false)
    expect(isBrowserTab(null)).toBe(false)
  })
  it('newTabId is unique-ish and non-empty', () => {
    expect(newTabId()).not.toBe(newTabId())
  })
})

describe('nextActiveAfterClose / reorderTabs / canAddTab', () => {
  const tabs = make(['a', 'b', 'c']).tabs
  it('prefers the right neighbour, then the left, then null', () => {
    expect(nextActiveAfterClose(tabs, 'a')).toBe('b')
    expect(nextActiveAfterClose(tabs, 'b')).toBe('c')
    expect(nextActiveAfterClose(tabs, 'c')).toBe('b')
    expect(nextActiveAfterClose([tab('a')], 'a')).toBeNull()
    expect(nextActiveAfterClose(tabs, 'zz')).toBeNull()
  })
  it('reorders with clamping and returns the same array for a no-op', () => {
    expect(reorderTabs(tabs, 'a', 2).map((t) => t.tabId)).toEqual(['b', 'c', 'a'])
    expect(reorderTabs(tabs, 'c', 0).map((t) => t.tabId)).toEqual(['c', 'a', 'b'])
    expect(reorderTabs(tabs, 'a', 99).map((t) => t.tabId)).toEqual(['b', 'c', 'a'])
    expect(reorderTabs(tabs, 'a', 0)).toBe(tabs)
    expect(reorderTabs(tabs, 'nope', 1)).toBe(tabs)
  })
  it('refuses a ninth tab with the visible reason', () => {
    expect(canAddTab(make(['a']))).toEqual({ ok: true })
    const full = make(Array.from({ length: MAX_TABS_PER_NODE }, (_, i) => `t${i}`))
    expect(canAddTab(full)).toEqual({ ok: false, reason: 'Tab limit (8) reached' })
    expect(TAB_LIMIT_REASON).toBe('Tab limit (8) reached')
  })
})

describe('reduceTabs', () => {
  it('new: appends and activates, inserts after a tab, validates the URL, respects the limit', () => {
    let s = reduceTabs(emptyTabsState(), { type: 'new', newTabId: 'a', url: 'https://a.test/' })
    expect(s).toMatchObject({ activeTabId: 'a', agentTabId: 'a' })
    s = reduceTabs(s, { type: 'new', newTabId: 'b' })
    s = reduceTabs(s, { type: 'new', newTabId: 'c', afterTabId: 'a', activate: false, openerTabId: 'a' })
    expect(ids(s)).toEqual(['a', 'c', 'b'])
    expect(s.activeTabId).toBe('b')
    expect(s.agentTabId).toBe('a')
    expect(s.tabs[1].openerTabId).toBe('a')
    expect(s.tabs[2].url).toBe('about:blank')
    expect(reduceTabs(s, { type: 'new', newTabId: 'x', url: 'javascript:1' })).toBe(s)
    expect(reduceTabs(s, { type: 'new', newTabId: 'a' })).toBe(s)
    const full = make(Array.from({ length: MAX_TABS_PER_NODE }, (_, i) => `t${i}`))
    expect(reduceTabs(full, { type: 'new', newTabId: 'x' })).toBe(full)
  })
  it('close: moves the active cursor to the neighbour, leaves it when a background tab closes, records history', () => {
    const s = make(['a', 'b', 'c'], 'b', 'c')
    const r = reduceTabs(s, { type: 'close', tabId: 'b' })
    expect(ids(r)).toEqual(['a', 'c'])
    expect(r.activeTabId).toBe('c')
    expect(r.closed.map((t) => t.tabId)).toEqual(['b'])
    const bg = reduceTabs(s, { type: 'close', tabId: 'a' })
    expect(bg.activeTabId).toBe('b')
    const agentGone = reduceTabs(s, { type: 'close', tabId: 'c' })
    expect(agentGone.agentTabId).toBe('b')
    expect(reduceTabs(s, { type: 'close', tabId: 'zz' })).toBe(s)
  })
  it('closing the last tab leaves no tabs and null cursors', () => {
    const r = reduceTabs(make(['a']), { type: 'close', tabId: 'a' })
    expect(r).toMatchObject({ tabs: [], activeTabId: null, agentTabId: null })
    expect(r.closed).toHaveLength(1)
  })
  it('closeOthers / closeToRight keep the right tabs and move cursors to a survivor', () => {
    const s = make(['a', 'b', 'c', 'd'], 'd', 'c')
    const others = reduceTabs(s, { type: 'closeOthers', tabId: 'b' })
    expect(ids(others)).toEqual(['b'])
    expect(others).toMatchObject({ activeTabId: 'b', agentTabId: 'b' })
    expect(others.closed.map((t) => t.tabId)).toEqual(['d', 'c', 'a'])
    const right = reduceTabs(s, { type: 'closeToRight', tabId: 'b' })
    expect(ids(right)).toEqual(['a', 'b'])
    expect(right.activeTabId).toBe('b')
  })
  it('history is capped at 10, newest first, and flags are reset', () => {
    let s = make(Array.from({ length: 8 }, (_, i) => `t${i}`))
    s = { ...s, tabs: s.tabs.map((t) => ({ ...t, loading: true, crashed: true })) }
    for (let i = 0; i < 8; i++) s = reduceTabs(s, { type: 'close', tabId: `t${i}` })
    for (let i = 0; i < 6; i++) {
      s = reduceTabs(s, { type: 'new', newTabId: `n${i}` })
      s = reduceTabs(s, { type: 'close', tabId: `n${i}` })
    }
    expect(s.closed).toHaveLength(MAX_CLOSED_HISTORY)
    expect(s.closed[0].tabId).toBe('n5')
    expect(s.closed.every((t) => !t.loading && !t.crashed)).toBe(true)
  })
  it('popOut removes without history; activate ignores unknown ids; reorder keeps cursors', () => {
    const s = make(['a', 'b', 'c'], 'b')
    const out = reduceTabs(s, { type: 'popOut', tabId: 'b' })
    expect(out.closed).toEqual([])
    expect(out.activeTabId).toBe('c')
    expect(reduceTabs(s, { type: 'activate', tabId: 'zz' })).toBe(s)
    expect(reduceTabs(s, { type: 'activate', tabId: 'b' })).toBe(s)
    expect(reduceTabs(s, { type: 'activate', tabId: 'c' }).activeTabId).toBe('c')
    const re = reduceTabs(s, { type: 'reorder', tabId: 'c', toIndex: 0 })
    expect(ids(re)).toEqual(['c', 'a', 'b'])
    expect(re.activeTabId).toBe('b')
    expect(reduceTabs(s, { type: 'reload', tabId: 'a' })).toBe(s)
  })
  it('duplicate inserts right after the source with cleared flags; limit blocks it', () => {
    const s: BrowserTabsState = { ...make(['a', 'b']), tabs: [tab('a', { crashed: true, loading: true, agent: true }), tab('b')] }
    const d = reduceTabs(s, { type: 'duplicate', tabId: 'a', newTabId: 'a2' })
    expect(ids(d)).toEqual(['a', 'a2', 'b'])
    expect(d.tabs[1]).toMatchObject({ url: 'https://a.test/', crashed: false, loading: false })
    expect(d.tabs[1].agent).toBeUndefined()
    expect(d.activeTabId).toBe('a2')
    expect(reduceTabs(s, { type: 'duplicate', tabId: 'zz', newTabId: 'x' })).toBe(s)
    const full = make(Array.from({ length: 8 }, (_, i) => `t${i}`))
    expect(reduceTabs(full, { type: 'duplicate', tabId: 't0', newTabId: 'x' })).toBe(full)
  })
  it('reopenClosed restores the newest (or a chosen) closed tab under a new id', () => {
    let s = make(['a', 'b', 'c'])
    s = reduceTabs(reduceTabs(s, { type: 'close', tabId: 'b' }), { type: 'close', tabId: 'c' })
    const r = reduceTabs(s, { type: 'reopenClosed', newTabId: 'c2' })
    expect(r.tabs.at(-1)).toMatchObject({ tabId: 'c2', url: 'https://c.test/' })
    expect(r.activeTabId).toBe('c2')
    expect(r.closed.map((t) => t.tabId)).toEqual(['b'])
    const pick = reduceTabs(s, { type: 'reopenClosed', newTabId: 'b2', fromTabId: 'b' })
    expect(pick.tabs.at(-1)?.url).toBe('https://b.test/')
    expect(reduceTabs(make(['a']), { type: 'reopenClosed', newTabId: 'x' }).tabs).toHaveLength(1)
    const full = { ...make(Array.from({ length: 8 }, (_, i) => `t${i}`)), closed: [tab('z')] }
    expect(reduceTabs(full, { type: 'reopenClosed', newTabId: 'x' })).toBe(full)
  })
})

describe('applyTabEvent', () => {
  const base = make(['a', 'b'], 'a', 'a')
  it('created inserts once at the index; updated patches; closed removes with cursor fix', () => {
    const c = applyTabEvent(base, { type: 'tabCreated', nodeId: 'n', tab: tab('x'), index: 1 })
    expect(ids(c)).toEqual(['a', 'x', 'b'])
    expect(applyTabEvent(c, { type: 'tabCreated', nodeId: 'n', tab: tab('x') })).toBe(c)
    const u = applyTabEvent(c, { type: 'tabUpdated', nodeId: 'n', tabId: 'x', patch: { loading: true, title: 'Hi' } })
    expect(u.tabs[1]).toMatchObject({ loading: true, title: 'Hi' })
    const gone = applyTabEvent(u, { type: 'tabClosed', nodeId: 'n', tabId: 'a' })
    expect(gone.activeTabId).toBe('x')
  })
  it('activated moves only the cursor named by `by`', () => {
    const h = applyTabEvent(base, { type: 'tabActivated', nodeId: 'n', tabId: 'b', by: 'human' })
    expect(h).toMatchObject({ activeTabId: 'b', agentTabId: 'a' })
    const a = applyTabEvent(base, { type: 'tabActivated', nodeId: 'n', tabId: 'b', by: 'agent' })
    expect(a).toMatchObject({ activeTabId: 'a', agentTabId: 'b' })
    expect(applyTabEvent(base, { type: 'tabActivated', nodeId: 'n', tabId: 'zz', by: 'human' })).toBe(base)
  })
})

describe('tabs in a split layout', () => {
  const split = (): BrowserTabsState => ({ ...make(['a', 'b', 'c', 'd'], 'b'), layout: { dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } } })
  it('activating a hidden tab takes over the focused pane; a shown tab only takes the focus', () => {
    const s = reduceTabs(split(), { type: 'activate', tabId: 'c' })
    expect(s.activeTabId).toBe('c')
    expect(s.layout).toEqual({ dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'c' } })
    const t = reduceTabs(split(), { type: 'activate', tabId: 'a' })
    expect(t.layout).toEqual(split().layout)
  })
  it('closing a shown tab hands its pane to the nearest hidden tab and the focus with it', () => {
    const s = reduceTabs(split(), { type: 'close', tabId: 'b' })
    expect(ids(s)).toEqual(['a', 'c', 'd'])
    expect(s.layout).toEqual({ dir: 'h', ratio: 0.5, a: { id: 'a' }, b: { id: 'c' } })
    expect(s.activeTabId).toBe('c')
  })
  it('closing the other tabs collapses the split', () => {
    const s = reduceTabs(split(), { type: 'closeOthers', tabId: 'b' })
    expect(ids(s)).toEqual(['b'])
    expect(s.layout).toBeUndefined()
  })
  it('applies layoutChanged events; null clears', () => {
    const s = applyTabEvent(make(['a', 'b']), { type: 'layoutChanged', nodeId: 'n', layout: split().layout as never })
    expect(s.layout).toBeDefined()
    expect(applyTabEvent(s, { type: 'layoutChanged', nodeId: 'n', layout: null }).layout).toBeUndefined()
  })
})
