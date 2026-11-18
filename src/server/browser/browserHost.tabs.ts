// Tab manager of browser nodes: one node = one Chromium page set; the node's view slot (rec.targetId/sessionId) follows the
// human's active tab and is the only page that streams. Other tabs are background targets in the table. The list rules
// (limit, neighbours on close, history) are the shared pure reducer `reduceTabs`; this file adds the CDP effects.
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import { BLANK_URL, reduceTabs, sanitizeTabTitle, validateTabUrl } from '../../shared/browser.tabs'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'
import { CDP } from './cdp.client'
import { screencastParams } from './browserHost.input'
import { castViewport } from './browserHost.device'
import { blockOf, BrowserError } from './browserHost.targets'
import type { NodeRec } from './browserHost.targets'
import { createKit } from './browserHost.tabs.kit'
import type { TabsOps } from './browserHost.tabs.kit'
import { createPopupSide } from './browserHost.tabs.popup'
import { createSplit } from './browserHost.split'

export { TabLimitError } from './browserHost.tabs.kit'
export type { TabsOps } from './browserHost.tabs.kit'

export interface NewTabReq { url?: string; afterTabId?: string; by: 'human' | 'agent' }

export function createTabs(ops: TabsOps) {
  const kit = createKit(ops)
  const { tabsOf, find, must, emitTab, patchTab, setState, send, fire, closeTarget, spawn, load, idOf } = kit
  const { table } = ops
  const split = createSplit(kit, { liveSession: (r, id) => liveSession(r, id), activate: (r, id) => moveCursors(r, { active: id }) })

  /** Fresh tab model for a node whose page is about to open: the board's saved list (all discarded but the active one) or empty. */
  function restore(rec: NodeRec): string | undefined {
    if (rec.tabs) return undefined
    const p = kit.initial(rec.nodeId)
    const tabs: BrowserTab[] = (p?.tabs ?? []).map((t) => ({ ...t, loading: false, discarded: t.tabId !== p?.activeTabId, crashed: false }))
    rec.tabs = { state: { tabs, activeTabId: p?.activeTabId ?? null, agentTabId: p?.agentTabId ?? null, closed: [], ...(p?.layout ? { layout: p.layout } : {}) }, rt: new Map(), followAgent: true }
    return tabs.find((t) => t.tabId === p?.activeTabId)?.url
  }

  /** The view target is bound: it belongs to the active tab (made on the spot for a node without tabs, e.g. an old board). */
  function bindView(rec: NodeRec): void {
    const t = tabsOf(rec)
    let id = t.state.activeTabId
    if (id === null || !find(t, id)) {
      id = idOf()
      const tab: BrowserTab = { tabId: id, title: '', url: rec.state.url || BLANK_URL, loading: false, discarded: false, crashed: false }
      t.state = { ...t.state, tabs: [...t.state.tabs, tab], activeTabId: id, agentTabId: t.state.agentTabId ?? id }
    }
    t.rt.set(id, { targetId: rec.targetId, sessionId: rec.sessionId })
    t.blank = undefined
    patchTab(rec, id, { discarded: false, crashed: false })
    kit.schedule(rec)
  }

  /** The view's page changed state: mirror url/title/loading into its tab. */
  function viewPatched(rec: NodeRec, part: Partial<BrowserState>): void {
    const id = rec.tabs?.state.activeTabId
    if (!rec.tabs || !id) return
    const patch: Partial<BrowserTab> = {}
    if (part.url) patch.url = part.url
    if (part.title !== undefined) patch.title = sanitizeTabTitle(part.title)
    if (part.loading !== undefined) patch.loading = part.loading
    patchTab(rec, id, patch)
  }

  /** The view target is gone (crash/detach): its tab is marked crashed; the node and the other tabs carry on. */
  function viewLost(rec: NodeRec): void {
    const t = rec.tabs
    const id = t?.state.activeTabId
    if (!t || !id) return
    t.rt.delete(id)
    t.blank = undefined
    patchTab(rec, id, { crashed: true, loading: false })
  }

  /** Node-level discard/connection loss: every tab becomes `discarded` (rebuilt on demand); `closeOthers` also closes the background pages. */
  function dropAll(rec: NodeRec, closeOthers: boolean): void {
    const t = rec.tabs
    if (!t) return
    kit.forgetTimers(rec)
    split.clear(rec)
    for (const [id, rt] of t.rt) {
      if (rt.targetId && rt.targetId !== rec.targetId) { if (closeOthers) closeTarget(rec, rt); else table.bgUnbind(rt.targetId, rt.sessionId) }
      patchTab(rec, id, { discarded: true, loading: false })
    }
    t.rt.clear()
    t.blank = undefined
    kit.flush(rec)
  }

  /** Page of `tabId` ready to use (the view's, a live background one, or rebuilt now); returns its session. */
  async function liveSession(rec: NodeRec, tabId: string): Promise<string> {
    const t = tabsOf(rec)
    const tab = must(rec, tabId)
    if (t.state.activeTabId === tabId && rec.sessionId) return rec.sessionId
    const live = t.rt.get(tabId)
    if (live?.sessionId) return live.sessionId
    const page = await spawn(rec)
    t.rt.set(tabId, page)
    table.bgBind(rec, tabId, page.targetId, page.sessionId)
    patchTab(rec, tabId, { discarded: false, crashed: false })
    await load(rec, page.sessionId, tab.url)
    kit.armDiscard(rec, tabId)
    return page.sessionId
  }

  /** Make `toTabId` the view: stop the old page's stream, bind the new page, restart the stream there. `closeOld` closes the old page. */
  async function setView(rec: NodeRec, toTabId: string, fromTabId: string | null, closeOld: boolean): Promise<void> {
    const t = tabsOf(rec)
    const sid = await liveSession(rec, toTabId)
    const to = must(rec, toTabId)
    const page = t.rt.get(toTabId) as { targetId: string; sessionId: string }
    const old = { targetId: rec.targetId, sessionId: rec.sessionId }
    const cast = rec.cast
    if (cast && old.sessionId) fire(rec, old.sessionId, CDP.stopScreencast)
    table.rebind(rec, page.targetId, sid)
    if (old.targetId && old.sessionId) {
      if (closeOld || fromTabId === null) { closeTarget(rec, old); if (fromTabId) t.rt.delete(fromTabId) }
      else { table.bgBind(rec, fromTabId, old.targetId, old.sessionId); kit.armDiscard(rec, fromTabId) }
    }
    t.state = { ...t.state, activeTabId: toTabId } // before the first patch below, so it lands in the new tab
    kit.cancelDiscard(rec, toTabId)
    rec.lat = undefined
    await kit.emulate(rec, sid)
    if (cast) {
      rec.cast = { ...cast, acks: new Map() }
      await send(rec, sid, CDP.startScreencast, screencastParams(castViewport(rec)))
    }
    ops.patch(rec, { url: to.url, title: to.title, loading: to.loading, canBack: false, canForward: false, netError: undefined, blocked: undefined, ...ops.shield.pageState(to.url) })
    void ops.refresh(rec)
    split.swapped(rec, toTabId, fromTabId)
  }

  /** Move the cursors, emitting one `tabActivated` per cursor that changed; the human's move swaps the view. */
  async function moveCursors(rec: NodeRec, to: { active?: string; agent?: string }): Promise<void> {
    const t = tabsOf(rec)
    if (to.agent && to.agent !== t.state.agentTabId) {
      setState(rec, { ...t.state, agentTabId: to.agent })
      emitTab(rec, { type: 'tabActivated', nodeId: rec.nodeId, tabId: to.agent, by: 'agent' })
    }
    if (to.active && to.active !== t.state.activeTabId) {
      const from = t.state.activeTabId
      await setView(rec, to.active, from, false)
      split.followFocus(rec, to.active, from)
      kit.schedule(rec)
      emitTab(rec, { type: 'tabActivated', nodeId: rec.nodeId, tabId: to.active, by: 'human' })
      await split.reconcile(rec)
    }
  }

  interface CreateOpts { url: string; afterTabId?: string; openerTabId?: string; focusHuman: boolean; focusAgent: boolean; title?: string; reopenedFrom?: string; adopt?: () => Promise<{ targetId: string; sessionId: string }> }
  /** Add a tab (own page, or an adopted popup page), place it, and move the cursors as asked. */
  async function create(rec: NodeRec, o: CreateOpts): Promise<BrowserTab> {
    const t = tabsOf(rec)
    kit.canAdd(rec)
    const id = idOf()
    const before = t.state
    const next = reduceTabs(before, { type: 'new', newTabId: id, url: o.url, afterTabId: o.afterTabId, openerTabId: o.openerTabId, activate: false })
    if (next === before) throw new BrowserError('bad_request', `node ${rec.nodeId}: tab could not be added`)
    const tab = { ...(next.tabs.find((x) => x.tabId === id) as BrowserTab), ...(o.title ? { title: o.title } : {}) }
    let page: { targetId: string; sessionId: string } | undefined
    const reuse = before.tabs.length === 0 ? t.blank : undefined
    try {
      if (reuse) { page = { targetId: rec.targetId as string, sessionId: rec.sessionId as string }; t.blank = undefined }
      else page = await (o.adopt ?? (() => spawn(rec)))()
    } catch (err) {
      throw err instanceof BrowserError ? err : new BrowserError('crashed', `node ${rec.nodeId}: could not open a tab page: ${err instanceof Error ? err.message : String(err)}`, undefined, err)
    }
    const viewIsThis = reuse !== undefined
    t.rt.set(id, page)
    if (!viewIsThis) table.bgBind(rec, id, page.targetId, page.sessionId)
    const index = next.tabs.findIndex((x) => x.tabId === id)
    t.state = { ...next, tabs: next.tabs.map((x) => (x.tabId === id ? tab : x)), closed: o.reopenedFrom ? next.closed.filter((c) => c.tabId !== o.reopenedFrom) : next.closed }
    emitTab(rec, { type: 'tabCreated', nodeId: rec.nodeId, tab, index, ...(o.reopenedFrom ? { reopenedFrom: o.reopenedFrom } : {}) })
    if (viewIsThis) emitTab(rec, { type: 'tabActivated', nodeId: rec.nodeId, tabId: id, by: 'human' })
    kit.schedule(rec)
    if (!o.adopt && o.url !== BLANK_URL) await load(rec, page.sessionId, o.url).catch((err) => { throw new BrowserError('crashed', `node ${rec.nodeId}: tab ${id} could not load: ${err instanceof Error ? err.message : String(err)}`, undefined, err) })
    kit.armDiscard(rec, id)
    await moveCursors(rec, { ...(o.focusHuman ? { active: id } : {}), ...(o.focusAgent ? { agent: id } : {}) })
    return find(tabsOf(rec), id) ?? tab
  }

  async function newTab(rec: NodeRec, req: NewTabReq): Promise<BrowserTab> {
    const url = validateTabUrl(req.url ?? '')
    if (!url.ok) throw new BrowserError('bad_request', `node ${rec.nodeId}: ${url.reason}`)
    if (url.url !== BLANK_URL) {
      const blocked = blockOf(ops.guard, url.url)
      if (blocked) { ops.patch(rec, { blocked: blocked.reason }); throw new BlockedError(blocked.reason, blocked.host) }
    }
    const t = tabsOf(rec)
    if (req.afterTabId) must(rec, req.afterTabId)
    return create(rec, { url: url.url, afterTabId: req.afterTabId, focusHuman: req.by === 'human' || t.followAgent, focusAgent: req.by === 'agent' })
  }

  /** Remove a tab and its page; the human's view moves to the neighbour (right, then left), or the node shows a blank page. */
  async function remove(rec: NodeRec, tabId: string, remember: boolean, backTo?: string): Promise<BrowserTabsState> {
    const t = tabsOf(rec)
    must(rec, tabId)
    const prev = t.state
    const next = reduceTabs(prev, { type: remember ? 'close' : 'popOut', tabId })
    const rt = t.rt.get(tabId)
    const wasView = prev.activeTabId === tabId
    kit.cancelDiscard(rec, tabId)
    const view = backTo ?? next.activeTabId
    if (wasView && view) {
      t.state = { ...next, activeTabId: prev.activeTabId } // the view still sits on this page until setView swaps it
      await setView(rec, view, tabId, true)
    } else if (wasView) {
      t.blank = rt
      if (rt?.sessionId) fire(rec, rt.sessionId, CDP.navigate, { url: BLANK_URL })
      ops.patch(rec, { url: '', title: '', loading: false, canBack: false, canForward: false, netError: undefined })
    } else closeTarget(rec, rt)
    t.rt.delete(tabId)
    t.state = wasView && backTo ? { ...next, activeTabId: backTo } : next
    emitTab(rec, { type: 'tabClosed', nodeId: rec.nodeId, tabId, ...(remember ? {} : { remember: false }) })
    if (prev.layout !== t.state.layout) split.noteLayout(rec, t.state.layout)
    kit.schedule(rec)
    await split.reconcile(rec)
    return next
  }

  /** The tab whose page is `targetId`, when its disappearance is a tab closing (another tab remains) and not the node losing its page. */
  function closedTab(rec: NodeRec, targetId: string): string | undefined {
    const t = rec.tabs
    if (!t || t.state.tabs.length < 2) return undefined
    return [...t.rt].find(([, rt]) => rt.targetId === targetId)?.[0]
  }

  /**
   * A page closed itself (`window.close()` of a popup: Chromium destroys the target; a crash is a different event). Its tab
   * goes like a user close, without entering "recently closed"; when it was the view, the view returns to the tab that
   * opened it (Chrome does the same; OAuth needs the opener on screen), else the neighbour.
   */
  async function pageClosed(rec: NodeRec, targetId: string): Promise<void> {
    const id = closedTab(rec, targetId)
    const t = rec.tabs
    if (!id || !t) return // already handled by the first of the destroyed/detached events
    const opener = find(t, id)?.openerTabId
    const back = t.state.activeTabId === id && opener && opener !== id && find(t, opener) ? opener : undefined
    await remove(rec, id, false, back)
  }

  async function move(rec: NodeRec, tabId: string, toIndex: number): Promise<void> {
    const t = tabsOf(rec)
    must(rec, tabId)
    const next = reduceTabs(t.state, { type: 'reorder', tabId, toIndex })
    if (next === t.state) return
    setState(rec, next)
    emitTab(rec, { type: 'tabMoved', nodeId: rec.nodeId, tabId, toIndex: next.tabs.findIndex((x) => x.tabId === tabId) })
  }

  async function duplicate(rec: NodeRec, tabId: string): Promise<BrowserTab> {
    const src = must(rec, tabId)
    return create(rec, { url: src.url, afterTabId: tabId, title: src.title, focusHuman: true, focusAgent: false })
  }

  async function reopenClosed(rec: NodeRec, fromTabId?: string): Promise<BrowserTab> {
    const t = tabsOf(rec)
    const src = fromTabId ? t.state.closed.find((c) => c.tabId === fromTabId) : t.state.closed[0]
    if (!src) throw new BrowserError('not_found', `node ${rec.nodeId}: no closed tab to reopen`)
    return create(rec, { url: src.url, title: src.title, focusHuman: true, focusAgent: false, reopenedFrom: src.tabId })
  }

  /** `by` human: the human's view (and the follow-agent switch turns off); `by` agent: the agent's cursor (and the view when following). */
  async function activate(rec: NodeRec, tabId: string, by: 'human' | 'agent'): Promise<void> {
    const t = tabsOf(rec)
    must(rec, tabId)
    if (by === 'human') { t.followAgent = false; await moveCursors(rec, { active: tabId }); return }
    await moveCursors(rec, { agent: tabId, ...(t.followAgent ? { active: tabId } : {}) })
  }

  function forget(rec: NodeRec): void { kit.forgetTimers(rec); kit.forgetSaved(rec.nodeId) }

  const popup = createPopupSide(kit, { create, liveSession, sideFrame: split.sidePush })
  return { split, restore, bindView, closedTab, pageClosed, viewPatched, viewLost, dropAll, liveSession, newTab, remove, move, duplicate, reopenClosed, activate, forget, flush: kit.flush, ...popup, state: (rec: NodeRec) => rec.tabs?.state }
}

export type TabManager = ReturnType<typeof createTabs>
