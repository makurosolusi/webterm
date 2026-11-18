// Tab wiring of the browser runtime: the service behind `/api/browser/:nodeId/tabs/*` (wakes the node through the single
// MAX_LIVE gate, answers with the board's saved list for a node the host has not opened, pops a tab out into a new node)
// and the debounced write of a node's tab list to the board.
import { randomUUID } from 'node:crypto'
import { BlockedError, BROWSER_KIND } from '../../shared/browser.contract'
import { BLANK_URL, emptyTabsState, validPersistedTabs } from '../../shared/browser.tabs'
import type { BrowserTab, BrowserTabsState, PersistedTabs } from '../../shared/browser.tabs'
import type { Workspace } from '../../shared/workspace'
import type { CanvasPush } from '../canvas/canvasPush'
import { createLogger } from '../logs'
import type { TabsApiDeps, TabsView } from '../browserApi.tabs'
import { OPEN_SIZE } from './browser.agentOpen'
import type { BrowserHost } from './browserHost.service'
import type { BrowserLifecycle } from './browserLifecycle.service'
import type { GatewayHost, ViewerHub } from './browserWs.viewers'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.tabs')

export interface TabsWiringDeps {
  host: BrowserHost
  lifecycle: BrowserLifecycle
  gwHost: GatewayHost
  hub: Pick<ViewerHub, 'count'>
  workspaces(): Workspace[]
  canvas(): Promise<Pick<CanvasPush, 'add' | 'remove' | 'update' | 'workspaceOfNode'>>
  /** Profile a node runs in (live switch included). */
  profileOf(nodeId: string, workspaceId: string): string
}

/** Write a node's tab list to its board (`canvas.update`, the same push every window folds in). A node already gone is not an error. */
export function tabPersister(canvas: TabsWiringDeps['canvas']): (nodeId: string, tabs: PersistedTabs | null) => void {
  return (nodeId, tabs) => {
    void (async () => {
      const c = await canvas()
      const ws = c.workspaceOfNode(nodeId)
      if (!ws) return
      const r = c.update({ workspaceId: ws.id, patches: [{ id: nodeId, tabs }] })
      if (!r.ok && r.code !== 'node_not_found') log.warn('browser.tabs.persist', 'board refused the tab list', { ids: { nodeId }, code: r.code })
    })().catch((err) => log.warn('browser.tabs.persist', 'saving the tab list failed', { ids: { nodeId }, error: err instanceof Error ? err.message : String(err) }))
  }
}

export function createTabsService(d: TabsWiringDeps): TabsApiDeps {
  const nodeOn = (id: string): { ws: Workspace; kind: string } | undefined => {
    for (const ws of d.workspaces()) { const n = ws.nodes.find((x) => x.id === id); if (n) return { ws, kind: n.kind } }
    return undefined
  }
  const board = (id: string) => d.workspaces().flatMap((w) => w.nodes).find((n) => n.id === id)

  /** The node's page up under the MAX_LIVE gate (the same `lifecycle.attach` every open uses); no viewer yet = it idles toward discard. */
  async function ensureLive(id: string): Promise<void> {
    if (d.host.state(id)?.live === 'live') return
    const home = nodeOn(id)
    const ws = d.host.workspaceOf(id) ?? (home?.kind === BROWSER_KIND ? home.ws.id : undefined)
    if (!ws) throw new BrowserError('not_found', `browser node ${id} is not on any board`)
    const r = await d.lifecycle.attach(id, ws, d.host.state(id)?.url || board(id)?.url || undefined)
    if (!r.ok) throw new BlockedError(r.blocked)
    if (d.hub.count(id) === 0) d.lifecycle.setVisible(id, false)
  }

  /** Live list, else the board's saved list shown as discarded tabs, else empty (a browser node); null = not a browser node. */
  function view(id: string): BrowserTabsState | null {
    const live = d.host.tabsState(id)
    if (live) return live
    const n = board(id)
    if (!n || n.kind !== BROWSER_KIND) return null
    const saved = validPersistedTabs(n.tabs)
    if (!saved) return emptyTabsState()
    return { tabs: saved.tabs.map((t) => ({ ...t, loading: false, discarded: true, crashed: false })), activeTabId: saved.activeTabId, agentTabId: saved.agentTabId, closed: [], ...(saved.layout ? { layout: saved.layout } : {}) }
  }
  const out = (id: string, tab?: BrowserTab, extra: Partial<TabsView> = {}): TabsView => ({ state: view(id) ?? emptyTabsState(), ...(tab ? { tab } : {}), ...extra })
  const act = async <T>(id: string, fn: () => Promise<T>): Promise<T> => { await ensureLive(id); return fn() }

  return {
    get: (id) => { const s = view(id); return s ? { state: s } : null },
    newTab: (id, o) => act(id, async () => out(id, await d.host.tabApi.newTab(id, { ...o, by: 'human' }))),
    activate: (id, tabId) => act(id, async () => { await d.host.tabApi.activate(id, tabId, 'human'); return out(id) }),
    close: (id, tabId) => act(id, async () => { await d.host.tabApi.closeTab(id, tabId); return out(id) }),
    move: (id, tabId, to) => act(id, async () => { await d.host.tabApi.move(id, tabId, to); return out(id) }),
    duplicate: (id, tabId) => act(id, async () => out(id, await d.host.tabApi.duplicate(id, tabId))),
    setLayout: (id, layout, focus) => act(id, async () => { await d.host.setLayout(id, layout, focus); return out(id) }),
    setDevice: (id, tabId, device) => act(id, async () => { await d.host.setTabDevice(id, tabId, device); return out(id) }),
    reopen: (id) => act(id, async () => out(id, await d.host.tabApi.reopen(id))),
    /**
     * Tab -> its own node beside this one: same profile (cookies come with it), same url, a fresh page (a live page cannot
     * move between windows over CDP, so scroll/form state is not carried). The new node starts under the MAX_LIVE gate
     * BEFORE the tab leaves; a full gate leaves everything as it was.
     */
    popOut: (id, tabId) => act(id, async () => {
      const tab = d.host.tabApi.state(id)?.tabs.find((t) => t.tabId === tabId)
      if (!tab) throw new BrowserError('not_found', `node ${id}: unknown tab ${tabId}`)
      const canvas = await d.canvas()
      const ws = canvas.workspaceOfNode(id)
      if (!ws) throw new BrowserError('not_found', `browser node ${id} is not on any board`)
      const newId = randomUUID()
      const profile = d.profileOf(id, ws.id)
      const url = tab.url === BLANK_URL ? undefined : tab.url
      const added = canvas.add({ workspaceId: ws.id, anchorNodeId: id, nodes: [{ id: newId, kind: BROWSER_KIND, x: 0, y: 0, ...OPEN_SIZE, ...(url ? { url } : {}), ...(profile !== ws.id ? { profileId: profile } : {}) }] })
      if (!added.ok) throw new BrowserError('bad_request', `node ${id}: could not add the pop-out node (${added.code})`)
      try {
        await d.gwHost.open(newId, ws.id, url)
        if (d.hub.count(newId) === 0) d.lifecycle.setVisible(newId, false) // not on screen yet: the idle clock starts, a viewer's attach stops it
      } catch (err) {
        canvas.remove({ workspaceId: ws.id, nodeIds: [newId] })
        throw err
      }
      await d.host.tabApi.popOut(id, tabId)
      return out(id, undefined, { newNodeId: newId })
    }),
  }
}
