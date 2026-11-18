// Contract for tabs inside one browser node (one Chromium window, many tabs): types, validators and a pure
// reducer shared by the client strip and (later) the server. No server/DB imports; ids are supplied by the caller.

export const MAX_TABS_PER_NODE = 8
export const MAX_CLOSED_HISTORY = 10
export const MAX_TAB_URL_LENGTH = 2048
export const MAX_TAB_TITLE_LENGTH = 300
export const BLANK_URL = 'about:blank'
export const TAB_LIMIT_REASON = `Tab limit (${MAX_TABS_PER_NODE}) reached`

export interface BrowserTab {
  tabId: string
  title: string
  url: string
  favicon?: string
  openerTabId?: string
  loading: boolean
  discarded: boolean
  crashed: boolean
  /** UI hint only; the source of truth is `agentTabId`. */
  agent?: boolean
}

export interface BrowserTabsState {
  tabs: BrowserTab[]
  /** The human's tab; null when every tab is closed (the node shows the new-tab page). */
  activeTabId: string | null
  /** The agent's working tab, independent of `activeTabId`. */
  agentTabId: string | null
  /** Recently closed tabs, newest first, at most MAX_CLOSED_HISTORY (Ctrl+Shift+T). */
  closed: BrowserTab[]
}

export type BrowserTabAction =
  | { type: 'new'; newTabId: string; url?: string; afterTabId?: string; openerTabId?: string; activate?: boolean }
  | { type: 'close'; tabId: string }
  | { type: 'closeOthers'; tabId: string }
  | { type: 'closeToRight'; tabId: string }
  | { type: 'activate'; tabId: string }
  | { type: 'reorder'; tabId: string; toIndex: number }
  | { type: 'reopenClosed'; newTabId: string; fromTabId?: string }
  | { type: 'duplicate'; tabId: string; newTabId: string }
  | { type: 'popOut'; tabId: string }
  /** No state change: the parent reloads the page. */
  | { type: 'reload'; tabId: string }

/** WS events of one node's tabs; `tabActivated.by` decides whether the human's or the agent's cursor moves. */
export type BrowserTabEvent =
  | { type: 'tabCreated'; nodeId: string; tab: BrowserTab; index?: number }
  | { type: 'tabUpdated'; nodeId: string; tabId: string; patch: Partial<Omit<BrowserTab, 'tabId'>> }
  | { type: 'tabClosed'; nodeId: string; tabId: string }
  | { type: 'tabActivated'; nodeId: string; tabId: string; by: 'human' | 'agent' }

export const emptyTabsState = (): BrowserTabsState => ({ tabs: [], activeTabId: null, agentTabId: null, closed: [] })

/** Fresh id for a client-created tab. */
export const newTabId = (): string => `tab-${globalThis.crypto.randomUUID().slice(0, 8)}`

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** Title as a safe string: non-strings become '', control chars dropped, truncated. */
export function sanitizeTabTitle(v: unknown): string {
  return typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_TAB_TITLE_LENGTH) : ''
}

export type TabUrlCheck = { ok: true; url: string } | { ok: false; reason: string }

/** Accepts http(s) and about:blank; empty means blank. Navigation safety (SSRF) stays with the server guard. */
export function validateTabUrl(v: unknown): TabUrlCheck {
  if (typeof v !== 'string') return { ok: false, reason: 'URL must be text' }
  const url = v.trim()
  if (url === '') return { ok: true, url: BLANK_URL }
  if (url.length > MAX_TAB_URL_LENGTH) return { ok: false, reason: `URL is longer than ${MAX_TAB_URL_LENGTH} characters` }
  if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'URL contains control characters' }
  if (url === BLANK_URL) return { ok: true, url }
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true, url } : { ok: false, reason: 'Only http and https URLs can be opened' }
  } catch {
    return { ok: false, reason: 'URL is not valid' }
  }
}

/** Structural check for a tab arriving over the wire. */
export function isBrowserTab(v: unknown): v is BrowserTab {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  const flags = [t.loading, t.discarded, t.crashed].every((f) => typeof f === 'boolean')
  const optional = (['favicon', 'openerTabId'] as const).every((k) => t[k] === undefined || typeof t[k] === 'string')
  return typeof t.tabId === 'string' && t.tabId !== '' && typeof t.title === 'string' && typeof t.url === 'string' && flags && optional
}

/** Chrome: closing the active tab activates the right neighbour, else the left one; null when none remain. */
export function nextActiveAfterClose(tabs: BrowserTab[], closedId: string): string | null {
  const i = tabs.findIndex((t) => t.tabId === closedId)
  if (i < 0) return null
  return (tabs[i + 1] ?? tabs[i - 1])?.tabId ?? null
}

export type CanAdd = { ok: true } | { ok: false; reason: string }

export function canAddTab(state: BrowserTabsState): CanAdd {
  return state.tabs.length >= MAX_TABS_PER_NODE ? { ok: false, reason: TAB_LIMIT_REASON } : { ok: true }
}

/** Moves `tabId` to `toIndex` (clamped); returns the same array when nothing changes. */
export function reorderTabs(tabs: BrowserTab[], tabId: string, toIndex: number): BrowserTab[] {
  const from = tabs.findIndex((t) => t.tabId === tabId)
  const to = Math.max(0, Math.min(tabs.length - 1, Math.trunc(toIndex)))
  if (from < 0 || from === to) return tabs
  const next = tabs.slice()
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

const blankTab = (tabId: string, url: string, openerTabId?: string): BrowserTab =>
  ({ tabId, title: '', url, loading: false, discarded: false, crashed: false, ...(openerTabId ? { openerTabId } : {}) })

/** Removes `ids`, keeps the cursors valid, records them (unless popping out) in the closed history. */
function removeTabs(state: BrowserTabsState, ids: Set<string>, remember: boolean): BrowserTabsState {
  const gone = state.tabs.filter((t) => ids.has(t.tabId))
  if (gone.length === 0) return state
  const tabs = state.tabs.filter((t) => !ids.has(t.tabId))
  // Walk right-then-left from the cursor's old slot, skipping tabs that are also going away.
  const survivor = (from: string | null): string | null => {
    if (from === null || !ids.has(from)) return from
    const i = state.tabs.findIndex((t) => t.tabId === from)
    const right = state.tabs.slice(i + 1).find((t) => !ids.has(t.tabId))
    return (right ?? state.tabs.slice(0, i).reverse().find((t) => !ids.has(t.tabId)))?.tabId ?? null
  }
  const reset = (t: BrowserTab): BrowserTab => ({ ...t, loading: false, discarded: false, crashed: false })
  const closed = remember ? [...gone.map(reset).reverse(), ...state.closed].slice(0, MAX_CLOSED_HISTORY) : state.closed
  return { tabs, activeTabId: survivor(state.activeTabId), agentTabId: survivor(state.agentTabId), closed }
}

/** Pure reducer for every tab action; refuses (returns the same state) when a rule such as the limit blocks it. */
export function reduceTabs(state: BrowserTabsState, a: BrowserTabAction): BrowserTabsState {
  const find = (id: string) => state.tabs.find((t) => t.tabId === id)
  const insert = (tab: BrowserTab, afterId: string | undefined, activate: boolean): BrowserTabsState => {
    if (!canAddTab(state).ok || find(tab.tabId)) return state
    const at = afterId ? state.tabs.findIndex((t) => t.tabId === afterId) : -1
    const tabs = state.tabs.slice()
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab)
    return { ...state, tabs, activeTabId: activate || state.activeTabId === null ? tab.tabId : state.activeTabId, agentTabId: state.agentTabId ?? tab.tabId }
  }
  switch (a.type) {
    case 'new': {
      const url = validateTabUrl(a.url ?? '')
      return url.ok ? insert(blankTab(a.newTabId, url.url, a.openerTabId), a.afterTabId, a.activate ?? true) : state
    }
    case 'duplicate': {
      const src = find(a.tabId)
      return src ? insert({ ...src, tabId: a.newTabId, loading: false, discarded: false, crashed: false, agent: undefined }, a.tabId, true) : state
    }
    case 'reopenClosed': {
      const src = a.fromTabId ? state.closed.find((t) => t.tabId === a.fromTabId) : state.closed[0]
      if (!src) return state
      const next = insert({ ...src, tabId: a.newTabId, agent: undefined, openerTabId: undefined }, undefined, true)
      return next === state ? state : { ...next, closed: state.closed.filter((t) => t !== src) }
    }
    case 'close': return removeTabs(state, new Set([a.tabId]), true)
    case 'popOut': return removeTabs(state, new Set([a.tabId]), false)
    case 'closeOthers': return find(a.tabId) ? removeTabs(state, new Set(state.tabs.filter((t) => t.tabId !== a.tabId).map((t) => t.tabId)), true) : state
    case 'closeToRight': {
      const i = state.tabs.findIndex((t) => t.tabId === a.tabId)
      return i < 0 ? state : removeTabs(state, new Set(state.tabs.slice(i + 1).map((t) => t.tabId)), true)
    }
    case 'activate': return find(a.tabId) && state.activeTabId !== a.tabId ? { ...state, activeTabId: a.tabId } : state
    case 'reorder': {
      const tabs = reorderTabs(state.tabs, a.tabId, a.toIndex)
      return tabs === state.tabs ? state : { ...state, tabs }
    }
    case 'reload': return state
  }
}

/** Applies a server event to the local state (server is the source of truth for ids and flags). */
export function applyTabEvent(state: BrowserTabsState, e: BrowserTabEvent): BrowserTabsState {
  switch (e.type) {
    case 'tabCreated': {
      if (state.tabs.some((t) => t.tabId === e.tab.tabId)) return state
      const tabs = state.tabs.slice()
      tabs.splice(e.index ?? tabs.length, 0, e.tab)
      return { ...state, tabs, activeTabId: state.activeTabId ?? e.tab.tabId, agentTabId: state.agentTabId ?? e.tab.tabId }
    }
    case 'tabUpdated': return { ...state, tabs: state.tabs.map((t) => (t.tabId === e.tabId ? { ...t, ...e.patch } : t)) }
    case 'tabClosed': return removeTabs(state, new Set([e.tabId]), true)
    case 'tabActivated':
      if (!state.tabs.some((t) => t.tabId === e.tabId)) return state
      return e.by === 'agent' ? { ...state, agentTabId: e.tabId } : { ...state, activeTabId: e.tabId }
  }
}
