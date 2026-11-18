// Tab state of one browser node: folds the WS `tabs`/`tab` messages, runs the strip's actions through the tabs REST API
// (optimistic where the id is known, rolled back with a toast on failure) and keeps "follow the agent" until the human
// picks a tab. The server owns ids, limits and the streamed page; this hook only mirrors and requests.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { BrowserState, ServerMsg } from '../../shared/browser.contract'
import {
  BLANK_URL, TAB_LIMIT_REASON, applyTabEvent, canAddTab, reduceTabs,
  type BrowserTab, type BrowserTabAction, type BrowserTabsState,
} from '../../shared/browser.tabs'
import { BrowserApiError } from '../browser.api'
import { showNotice } from '../workspaceSave.notice'
import { showLimitNotice } from '../browserLimit.notice'
import { tabsApi, type TabsView } from './browserTabs.api'
import type { Pane } from '../../shared/workspace.shape'
import type { DeviceChoice } from '../../shared/browser.devices'

export type TabMsg = Extract<ServerMsg, { t: 'tabs' | 'tab' | 'tabNotice' }>
export const isTabMsg = (m: ServerMsg): m is TabMsg => m.t === 'tabs' || m.t === 'tab' || m.t === 'tabNotice'

/** Id of the single stand-in tab shown until the server has sent the node's tab list. */
export const PAGE_TAB_ID = '__page'
/** Pause before the one automatic retry of a failed tab activation. */
const ACTIVATE_RETRY_MS = 150
const MAX_LIVE_TEXT = 'Too many browsers are active. Hide one first.'

const noticeKey = (nodeId: string): string => `webterm-browser-tabs-${nodeId}`

/** A node with no tab data yet (old board, or not attached) shows its one page as a single tab. */
function pageTab(page?: BrowserState): BrowserTab {
  return {
    tabId: PAGE_TAB_ID, title: page?.title ?? '', url: page?.url ?? BLANK_URL, loading: page?.loading ?? false, discarded: false, crashed: false,
  }
}

function failText(verb: string, e: unknown): { text: string; severity: 'warning' | 'error' } {
  if (e instanceof BrowserApiError && e.code === 'tab_limit') return { text: TAB_LIMIT_REASON, severity: 'warning' }
  if (e instanceof BrowserApiError && e.code === 'max_live') return { text: MAX_LIVE_TEXT, severity: 'warning' }
  return { text: `Could not ${verb}: ${e instanceof Error ? e.message : 'unknown error'}`, severity: 'error' }
}

const VERB: Record<BrowserTabAction['type'], string> = {
  new: 'open a new tab', close: 'close the tab', closeOthers: 'close the other tabs', closeToRight: 'close the tabs to the right',
  activate: 'switch tabs', reorder: 'move the tab', reopenClosed: 'reopen the tab', duplicate: 'duplicate the tab', popOut: 'pop the tab out', reload: 'reload the tab',
}

export interface BrowserTabsControl {
  /** What the strip shows (a stand-in single tab until the server's list arrives). */
  view: BrowserTabsState
  /** The active tab, or undefined when every tab is closed. */
  active?: BrowserTab
  /** True while the strip only has the stand-in page tab. */
  standIn: boolean
  act: (a: BrowserTabAction) => void
  notify: (text: string, severity?: 'info' | 'warning' | 'error') => void
  /** Feed for the session's WS listener. */
  onMsg: (m: TabMsg) => void
  /** Counts the server's whole-list messages (every attach); a change = the server may have forgotten what is on screen. */
  epoch: number
  /** Split layout: shown at once (`save` false = a drag in progress, kept local); `focus` also moves the human's view. */
  setLayout: (layout: Pane | null, o?: { focus?: string; save?: boolean }) => Promise<void>
  /** A new tab (the server picks the id); resolves to it, or null when it was refused (a notice says why). */
  createTab: (url?: string, afterTabId?: string) => Promise<BrowserTab | null>
  /** One tab's own device (null = follow the pane size); applied at once, rolled back on failure. */
  setTabDevice: (tabId: string, device: DeviceChoice | null) => Promise<void>
}

export function useBrowserTabs(nodeId: string, page: BrowserState | undefined, send: (m: { t: 'nav'; action: 'reload' }) => void): BrowserTabsControl {
  const [state, setStateRaw] = useState<BrowserTabsState | null>(null)
  const ref = useRef<BrowserTabsState | null>(null)
  const follow = useRef(true)
  const activateSeq = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const setState = useCallback((s: BrowserTabsState | null) => { ref.current = s; setStateRaw(s) }, [])
  const notify = useCallback((text: string, severity?: 'info' | 'warning' | 'error') => {
    const sev = severity ?? (text === TAB_LIMIT_REASON ? 'warning' : 'info')
    if (text === MAX_LIVE_TEXT) void showLimitNotice(noticeKey(nodeId), sev, text) // the active-browser limit: offer to raise it
    else showNotice(noticeKey(nodeId), { severity: sev, title: text })
  }, [nodeId])

  const onMsg = useCallback((m: TabMsg) => {
    if (m.t === 'tabs') { setState(m.state); setEpoch((n) => n + 1) }
    else if (m.t === 'tabNotice') notify(m.message, 'warning')
    else if (ref.current) {
      const next = applyTabEvent(ref.current, m.event)
      // Follow the agent: the server already moved the streamed page; mirror it unless the human chose a tab.
      const e = m.event
      setState(e.type === 'tabActivated' && e.by === 'agent' && follow.current && next.tabs.some((t) => t.tabId === e.tabId) ? { ...next, activeTabId: e.tabId } : next)
    }
  }, [setState, notify])

  /** Optimistic `a` (when the id is known), then the request; the answer replaces the state, a failure restores it. */
  const commit = useCallback((a: BrowserTabAction, optimistic: boolean, call: () => Promise<TabsView>, onDone?: (r: TabsView) => void) => {
    const prev = ref.current
    if (optimistic && prev) setState(reduceTabs(prev, a))
    call().then(
      (r) => { setState(r.state); onDone?.(r) },
      (e: unknown) => {
        if (optimistic) setState(prev)
        const f = failText(VERB[a.type], e)
        notify(f.text, f.severity)
      },
    )
  }, [setState, notify])

  const act = useCallback((a: BrowserTabAction) => {
    const cur = ref.current
    if (a.type === 'new') {
      const full = cur ? canAddTab(cur) : { ok: true as const }
      if (!full.ok) { notify(full.reason, 'warning'); return }
      commit(a, false, () => tabsApi.create(nodeId, { ...(a.url ? { url: a.url } : {}), ...(a.afterTabId ? { afterTabId: a.afterTabId } : {}) }))
      return
    }
    if (!cur) return // stand-in page tab: nothing but "new" can be asked of it
    switch (a.type) {
      case 'activate':
        follow.current = false // the human chose: stop following the agent
        if (cur.activeTabId !== a.tabId) {
          // The click takes effect at once. Two quick clicks send two requests: only the newest answer counts (an older one
          // would flip the tab back). A failed request is retried once (the server can fail transiently while it moves the
          // screencast); when it still fails the user's choice stays on screen and only then is it reported.
          const n = ++activateSeq.current
          setState(reduceTabs(cur, a))
          const ask = () => tabsApi.activate(nodeId, a.tabId)
          const retry = async (): Promise<TabsView> => {
            try { return await ask() } catch { await new Promise((r) => setTimeout(r, ACTIVATE_RETRY_MS)); return ask() }
          }
          retry().then(
            (r) => { if (n === activateSeq.current) setState(r.state) },
            (e: unknown) => { if (n === activateSeq.current) { const f = failText(VERB.activate, e); notify(f.text, f.severity) } },
          )
        }
        return
      case 'close': commit(a, true, () => tabsApi.close(nodeId, a.tabId)); return
      case 'closeOthers': case 'closeToRight': {
        const at = cur.tabs.findIndex((t) => t.tabId === a.tabId)
        const gone = cur.tabs.filter((t, i) => (a.type === 'closeOthers' ? t.tabId !== a.tabId : i > at)).map((t) => t.tabId)
        commit(a, true, async () => { let last: TabsView = { state: cur }; for (const id of gone) last = await tabsApi.close(nodeId, id); return last })
        return
      }
      case 'reorder': commit(a, true, () => tabsApi.move(nodeId, a.tabId, a.toIndex)); return
      case 'duplicate': commit(a, false, () => tabsApi.duplicate(nodeId, a.tabId)); return
      case 'popOut':
        commit(a, true, () => tabsApi.popOut(nodeId, a.tabId), (r) => { if (r.newNodeId) notify('Tab opened in its own browser node') })
        return
      case 'reopenClosed': {
        const full = canAddTab(cur)
        if (!full.ok) { notify(full.reason, 'warning'); return }
        // The server reopens the newest entry; an older one is reopened as a fresh tab at its url.
        const older = a.fromTabId && a.fromTabId !== cur.closed[0]?.tabId ? cur.closed.find((t) => t.tabId === a.fromTabId) : undefined
        commit(a, false, () => (older ? tabsApi.create(nodeId, { url: older.url }) : tabsApi.reopen(nodeId)))
        return
      }
      case 'reload':
        if (cur.activeTabId === a.tabId) { send({ t: 'nav', action: 'reload' }); return }
        follow.current = false
        commit({ type: 'activate', tabId: a.tabId }, true, () => tabsApi.activate(nodeId, a.tabId), () => send({ t: 'nav', action: 'reload' }))
    }
  }, [nodeId, commit, notify, send])

  const setLayout = useCallback(async (layout: Pane | null, o: { focus?: string; save?: boolean } = {}) => {
    const prev = ref.current
    if (!prev) return
    const next = { ...prev, ...(o.focus ? { activeTabId: o.focus } : {}) }
    if (layout) next.layout = layout
    else delete next.layout
    setState(next)
    if (o.focus) follow.current = false
    if (o.save === false) return
    try {
      setState((await tabsApi.layout(nodeId, layout, o.focus)).state)
    } catch (e) {
      setState(prev)
      const f = failText('change the split', e)
      notify(f.text, f.severity)
    }
  }, [nodeId, setState, notify])

  const createTab = useCallback(async (url?: string, afterTabId?: string): Promise<BrowserTab | null> => {
    const cur = ref.current
    const full = cur ? canAddTab(cur) : { ok: true as const }
    if (!full.ok) { notify(full.reason, 'warning'); return null }
    try {
      const r = await tabsApi.create(nodeId, { ...(url ? { url } : {}), ...(afterTabId ? { afterTabId } : {}) })
      setState(r.state)
      return r.tab ?? null
    } catch (e) {
      const f = failText('open a new tab', e)
      notify(f.text, f.severity)
      return null
    }
  }, [nodeId, setState, notify])

  const setTabDevice = useCallback(async (tabId: string, device: DeviceChoice | null) => {
    const prev = ref.current
    if (!prev) return
    setState({ ...prev, tabs: prev.tabs.map((t) => (t.tabId === tabId ? { ...t, device } : t)) })
    try {
      setState((await tabsApi.device(nodeId, tabId, device)).state)
    } catch (e) {
      setState(prev)
      const f = failText('change the device', e)
      notify(f.text, f.severity)
    }
  }, [nodeId, setState, notify])

  const view = useMemo<BrowserTabsState>(() => {
    if (state) return state
    const tab = pageTab(page)
    // No agent marker: nothing is attached to this node yet, so no agent can be "here" (the server's list sets it).
    return { tabs: [tab], activeTabId: tab.tabId, agentTabId: null, closed: [] }
  }, [state, page])
  const active = view.tabs.find((t) => t.tabId === view.activeTabId)
  return { view, active, standIn: state === null, act, notify, onMsg, epoch, setLayout, createTab, setTabDevice }
}
