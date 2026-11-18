// Public face of a node's tabs on the host: serialized actions (API + agent), and per-tab CDP so an agent can work in a
// tab that is not the one the human is looking at. The rules live in `browserHost.tabs.ts`; this file only guards and routes.
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserInputEvent, BrowserState } from '../../shared/browser.contract'
import type { BrowserTab, BrowserTabsState } from '../../shared/browser.tabs'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { toCdpCommands } from './browserHost.input'
import { blockOf, BrowserError } from './browserHost.targets'
import type { NavGuard, NodeRec, TargetTable } from './browserHost.targets'
import type { NewTabReq, TabManager } from './browserHost.tabs'

export interface TabApiDeps {
  table: TargetTable
  tabs: TabManager
  guard: NavGuard
  cdpOf(rec: NodeRec): Promise<CdpClient>
  patch(rec: NodeRec, part: Partial<BrowserState>): void
}

/** A tab taken out of its node (pop-out): what the new node needs to reopen it. */
export interface PoppedTab { url: string; title: string; state: BrowserTabsState }

export function createTabApi(d: TabApiDeps) {
  const tails = new Map<string, Promise<unknown>>()
  /** One tab action at a time per node: two quick clicks (close + new) must not interleave their CDP steps. */
  const serial = <T>(nodeId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(nodeId) ?? Promise.resolve()).then(fn, fn)
    const settled = run.then(() => undefined, () => undefined)
    tails.set(nodeId, settled)
    void settled.then(() => { if (tails.get(nodeId) === settled) tails.delete(nodeId) })
    return run
  }
  const known = (nodeId: string): NodeRec => {
    const rec = d.table.nodes.get(nodeId)
    if (!rec?.tabs) throw new BrowserError('not_found', `node ${nodeId} has no tabs yet (its page has not opened)`)
    return rec
  }
  const live = (nodeId: string): NodeRec => {
    const rec = known(nodeId)
    if (!rec.sessionId) throw new BrowserError('crashed', `node ${nodeId} has no live browser page; wake it first`)
    return rec
  }
  const action = <T>(nodeId: string, fn: (rec: NodeRec) => Promise<T>): Promise<T> => serial(nodeId, () => fn(live(nodeId)))
  const tab = (rec: NodeRec, tabId: string): BrowserTab => {
    const t = rec.tabs?.state.tabs.find((x) => x.tabId === tabId)
    if (!t) throw new BrowserError('not_found', `node ${rec.nodeId}: unknown tab ${tabId}`)
    return t
  }

  return {
    /** Run `fn` in the node's action queue (popup adoption shares it with the API actions). */
    run: serial,
    /** Tab list of a node; undefined = the host has not opened it (callers fall back to the board's saved list). */
    state: (nodeId: string): BrowserTabsState | undefined => d.table.nodes.get(nodeId)?.tabs?.state,
    newTab: (nodeId: string, req: NewTabReq) => action(nodeId, (rec) => d.tabs.newTab(rec, req)),
    closeTab: (nodeId: string, tabId: string) => action(nodeId, (rec) => d.tabs.remove(rec, tabId, true)),
    activate: (nodeId: string, tabId: string, by: 'human' | 'agent') => action(nodeId, (rec) => d.tabs.activate(rec, tabId, by)),
    move: (nodeId: string, tabId: string, toIndex: number) => action(nodeId, (rec) => d.tabs.move(rec, tabId, toIndex)),
    duplicate: (nodeId: string, tabId: string) => action(nodeId, (rec) => d.tabs.duplicate(rec, tabId)),
    reopen: (nodeId: string, fromTabId?: string) => action(nodeId, (rec) => d.tabs.reopenClosed(rec, fromTabId)),
    /** The tab's own page reloads (a discarded or crashed one is rebuilt at its url instead). */
    reload: (nodeId: string, tabId: string) => action(nodeId, async (rec) => {
      const t = tab(rec, tabId)
      const down = t.discarded || t.crashed
      const sid = await d.tabs.liveSession(rec, tabId)
      if (!down) await (await d.cdpOf(rec)).send(CDP.reload, {}, sid)
    }),
    /** Take a tab out of its node without remembering it as closed (the caller reopens it elsewhere). */
    popOut: (nodeId: string, tabId: string): Promise<PoppedTab> => action(nodeId, async (rec) => {
      const t = tab(rec, tabId)
      const state = await d.tabs.remove(rec, tabId, false)
      return { url: t.url, title: t.title, state }
    }),
    /** Tab the human views / the agent works in; undefined = unknown node or no tabs. */
    viewTab: (nodeId: string): string | undefined => d.table.nodes.get(nodeId)?.tabs?.state.activeTabId ?? undefined,
    agentTab: (nodeId: string): string | undefined => d.table.nodes.get(nodeId)?.tabs?.state.agentTabId ?? undefined,
    /** State of one tab as a `BrowserState` (the view's is the node's own). */
    stateOfTab(nodeId: string, tabId: string): BrowserState | undefined {
      const rec = d.table.nodes.get(nodeId)
      const t = rec?.tabs?.state.tabs.find((x) => x.tabId === tabId)
      if (!rec || !t) return undefined
      if (rec.tabs?.state.activeTabId === tabId) return { ...rec.state }
      return { id: nodeId, url: t.url, title: t.title, loading: t.loading, canBack: false, canForward: false, lease: rec.state.lease, live: t.discarded || t.crashed ? 'discarded' : 'live' }
    },
    /** CDP on a specific tab; a discarded background tab is rebuilt first. */
    cdpOnTab: (nodeId: string, tabId: string, method: string, params?: object) => serial(nodeId, async () => {
      const rec = live(nodeId)
      return (await d.cdpOf(rec)).send(method, params, await d.tabs.liveSession(rec, tabId))
    }),
    inputOnTab: (nodeId: string, tabId: string, ev: BrowserInputEvent) => serial(nodeId, async () => {
      const rec = live(nodeId)
      const cdp = await d.cdpOf(rec)
      const sid = await d.tabs.liveSession(rec, tabId)
      for (const c of toCdpCommands(ev)) await cdp.send(c.method, c.params, sid)
    }),
    navigateTab: (nodeId: string, tabId: string, url: string) => serial(nodeId, async () => {
      const rec = live(nodeId)
      const blocked = blockOf(d.guard, url)
      if (blocked) { d.patch(rec, { blocked: blocked.reason }); throw new BlockedError(blocked.reason, blocked.host) }
      const sid = await d.tabs.liveSession(rec, tabId)
      const r = await (await d.cdpOf(rec)).send<{ errorText?: string }>(CDP.navigate, { url }, sid)
      if (r.errorText && !/ERR_ABORTED$/.test(r.errorText)) throw new BrowserError('crashed', `node ${nodeId}: tab ${tabId} could not load the page (${r.errorText})`)
    }),
  }
}

export type TabApi = ReturnType<typeof createTabApi>
