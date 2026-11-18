// Shared plumbing of the tab manager (state mutation, events, CDP helpers, persistence, discard timers).
// `browserHost.tabs.ts` builds the actions on top of it; `browserHost.tabs.popup.ts` the popup/background-event side.
import { DEFAULT_DISCARD_MS } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import { BLANK_URL, MAX_FAVICON_URL_LENGTH, MAX_TABS_PER_NODE, sanitizeTabTitle, TAB_LIMIT_REASON, validPersistedTabs } from '../../shared/browser.tabs'
import type { BrowserTab, BrowserTabEvent, BrowserTabsState, PersistedTabs } from '../../shared/browser.tabs'
import { createLogger } from '../logs'
import { stopCast } from './browserHost.cast'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { deviceCommands } from './browserHost.device'
import type { DeviceIo } from './browserHost.device'
import type { ConsoleLog } from './browserHost.console'
import type { ShieldRouter } from './browserHost.shield'
import { BrowserError, createPageTarget } from './browserHost.targets'
import type { HostEvent, NavGuard, NodeRec, NodeTabs, TabRt, TargetTable } from './browserHost.targets'
import { metricsParams } from './browserHost.input'

const log = createLogger('browser.tabs')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Wait before a changed tab list is written to the board (title/url churn while a page loads). */
export const PERSIST_DEBOUNCE_MS = 1500

/** Refused because the node already holds MAX_TABS_PER_NODE tabs. */
export class TabLimitError extends BrowserError {
  constructor(nodeId: string) {
    super('bad_request', `node ${nodeId}: ${TAB_LIMIT_REASON}`)
    this.name = 'TabLimitError'
  }
}

export interface TabsOps {
  table: TargetTable
  guard: NavGuard
  cdpOf(rec: NodeRec): Promise<CdpClient>
  patch(rec: NodeRec, part: Partial<BrowserState>): void
  emit(e: HostEvent): void
  io(rec: NodeRec): DeviceIo
  shield: ShieldRouter
  console: ConsoleLog
  refresh(rec: NodeRec): Promise<void>
  /** Tab list saved on the board (`WsNode.tabs`); read once when a node's page first opens. */
  initialTabs?(nodeId: string): unknown
  /** Write the node's tab list to the board (debounced here); the runtime owns the actual save. */
  persist?(nodeId: string, tabs: PersistedTabs | null): void
  /** True while an agent holds the node's lease (a popup then counts as the agent's doing). */
  agentDriving?(nodeId: string): boolean
  /** Idle time before a background tab is discarded (same setting as the node's discard delay). */
  discardMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(h: unknown): void
  newId?(): string
}

export type Tabs = NodeTabs

/** Only a short http(s) icon url goes on the board (never icon bytes); `validPersistedTabs` applies the same rule when reading back. */
const persistableIcon = (u: string | undefined): boolean => !!u && u.length <= MAX_FAVICON_URL_LENGTH && /^https?:\/\//i.test(u)

export function createKit(ops: TabsOps) {
  const setTimer = ops.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
  const clearTimer = ops.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const saveTimers = new Map<string, unknown>()
  const discardTimers = new Map<string, unknown>() // `${nodeId}/${tabId}`
  const lastSaved = new Map<string, string>()
  const idOf = (): string => ops.newId?.() ?? `tab-${globalThis.crypto.randomUUID().slice(0, 8)}`

  const tabsOf = (rec: NodeRec): Tabs => {
    if (!rec.tabs) throw new BrowserError('not_found', `node ${rec.nodeId} has no tab model yet (its page has not opened)`)
    return rec.tabs
  }
  const find = (t: Tabs, id: string): BrowserTab | undefined => t.state.tabs.find((x) => x.tabId === id)
  const must = (rec: NodeRec, id: string): BrowserTab => {
    const tab = find(tabsOf(rec), id)
    if (!tab) throw new BrowserError('not_found', `node ${rec.nodeId}: unknown tab ${id}`)
    return tab
  }
  const emitTab = (rec: NodeRec, event: BrowserTabEvent): void => ops.emit({ k: 'tab', nodeId: rec.nodeId, event })
  const notice = (rec: NodeRec, message: string): void => ops.emit({ k: 'tabNotice', nodeId: rec.nodeId, message })

  const toPersisted = (s: BrowserTabsState): PersistedTabs | null => s.tabs.length === 0 ? null : {
    tabs: s.tabs.map((t) => ({ tabId: t.tabId, url: t.url, title: t.title, ...(persistableIcon(t.favicon) ? { favicon: t.favicon } : {}), ...(t.openerTabId ? { openerTabId: t.openerTabId } : {}), ...(t.device ? { device: t.device } : {}) })),
    activeTabId: s.activeTabId, agentTabId: s.agentTabId, ...(s.layout ? { layout: s.layout } : {}),
  }
  const flush = (rec: NodeRec): void => {
    const h = saveTimers.get(rec.nodeId)
    if (h !== undefined) { clearTimer(h); saveTimers.delete(rec.nodeId) }
    if (!rec.tabs || !ops.persist) return
    const next = toPersisted(rec.tabs.state)
    const key = JSON.stringify(next)
    if (lastSaved.get(rec.nodeId) === key) return
    lastSaved.set(rec.nodeId, key)
    try { ops.persist(rec.nodeId, next) } catch (err) { log.warn('browser.tabs.persist', 'saving the tab list failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) }) }
  }
  const schedule = (rec: NodeRec): void => {
    if (!ops.persist || saveTimers.has(rec.nodeId)) return
    saveTimers.set(rec.nodeId, setTimer(() => { saveTimers.delete(rec.nodeId); flush(rec) }, PERSIST_DEBOUNCE_MS))
  }

  /** Apply a patch to one tab; emits `tabUpdated` and schedules a save when something changed. */
  const patchTab = (rec: NodeRec, tabId: string, patch: Partial<Omit<BrowserTab, 'tabId'>>): void => {
    const t = tabsOf(rec)
    const cur = find(t, tabId)
    if (!cur) return
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => patch[k] !== cur[k])
    if (changed.length === 0) return
    t.state = { ...t.state, tabs: t.state.tabs.map((x) => (x.tabId === tabId ? { ...x, ...patch } : x)) }
    emitTab(rec, { type: 'tabUpdated', nodeId: rec.nodeId, tabId, patch: Object.fromEntries(changed.map((k) => [k, patch[k]])) })
    if (changed.some((k) => k === 'url' || k === 'title' || k === 'favicon' || k === 'device')) schedule(rec)
  }
  const setState = (rec: NodeRec, next: BrowserTabsState): void => { tabsOf(rec).state = next; schedule(rec) }

  const send = async (rec: NodeRec, sid: string, method: string, params: object = {}): Promise<Record<string, unknown>> =>
    (await ops.cdpOf(rec)).send<Record<string, unknown>>(method, params, sid)
  /** Fire-and-forget CDP command on a tab session; failures (the page is going away anyway) are logged, not thrown. */
  const fire = (rec: NodeRec, sid: string | undefined, method: string, params: object = {}): void => {
    if (!sid) return
    send(rec, sid, method, params).catch((err) => log.warn('browser.tabs.cdp', 'tab command failed', { ids: { nodeId: rec.nodeId }, method, error: errMsg(err) }))
  }
  /** Stop a tab page's stream and wait for it; a page that is not streaming, or is already gone, is not an error. */
  const stopStream = async (rec: NodeRec, sid: string): Promise<void> => {
    try { await stopCast((m, p) => send(rec, sid, m, p ?? {}), `node ${rec.nodeId}`) } catch (err) {
      log.warn('browser.tabs.cdp', 'stopping a tab stream failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) })
    }
  }
  const closeTarget = (rec: NodeRec, rt: TabRt | undefined): void => {
    if (!rt?.targetId) return
    ops.table.bgUnbind(rt.targetId, rt.sessionId)
    ops.cdpOf(rec).then((c) => c.send(CDP.closeTarget, { targetId: rt.targetId }))
      .catch((err) => log.warn('browser.tabs.close', 'closing a tab target failed (it may already be gone)', { ids: { nodeId: rec.nodeId }, error: errMsg(err) }))
  }

  /** Emulation of the node (device or size) on a tab session, so a tab that was in the background renders like the view. */
  const emulate = async (rec: NodeRec, sid: string): Promise<void> => {
    const cmds = rec.device ? deviceCommands(rec.device) : [{ method: CDP.setDeviceMetrics, params: metricsParams(rec.viewport.w, rec.viewport.h, rec.viewport.dpr) }]
    for (const c of cmds) await send(rec, sid, c.method, c.params)
  }
  /** Fresh page for a tab (own offscreen window: CDP cannot place a target in an existing one), ready like the node's first. */
  const spawn = async (rec: NodeRec): Promise<Required<TabRt>> => {
    const cdp = await ops.cdpOf(rec)
    const t = await createPageTarget(cdp, rec.viewport)
    await ops.shield.enable(cdp, t.sessionId)
    await ops.console.enable(cdp, t.sessionId)
    if (rec.device) await emulate(rec, t.sessionId)
    return t
  }
  const load = async (rec: NodeRec, sid: string, url: string): Promise<void> => {
    if (url === '' || url === BLANK_URL) return
    const r = await send(rec, sid, CDP.navigate, { url })
    if (typeof r.errorText === 'string') log.warn('browser.tabs.nav', 'tab navigation failed', { ids: { nodeId: rec.nodeId }, error: r.errorText })
  }

  const discardKey = (rec: NodeRec, tabId: string) => `${rec.nodeId}/${tabId}`
  const cancelDiscard = (rec: NodeRec, tabId: string): void => {
    const h = discardTimers.get(discardKey(rec, tabId))
    if (h === undefined) return
    clearTimer(h)
    discardTimers.delete(discardKey(rec, tabId))
  }
  /** Drop a background tab's page (closeTarget); the tab stays in the list and is rebuilt when activated. */
  const discardTab = (rec: NodeRec, tabId: string): void => {
    const t = tabsOf(rec)
    const rt = t.rt.get(tabId)
    closeTarget(rec, rt)
    t.rt.delete(tabId)
    patchTab(rec, tabId, { discarded: true, loading: false })
  }
  const armDiscard = (rec: NodeRec, tabId: string): void => {
    cancelDiscard(rec, tabId)
    const key = discardKey(rec, tabId)
    discardTimers.set(key, setTimer(() => {
      discardTimers.delete(key)
      const t = rec.tabs
      const tab = t && find(t, tabId)
      if (!t || !tab || !t.rt.get(tabId)?.targetId || t.state.activeTabId === tabId) return
      if (t.split?.visible.includes(tabId)) { armDiscard(rec, tabId); return } // on screen in a split pane: not idle
      // The agent's working tab and tabs still loading are not idle; look again later.
      // A tab with a live popup is the popup's `window.opener` (OAuth waits for its postMessage): discarding it would break the login.
      const hasPopup = t.state.tabs.some((x) => x.openerTabId === tabId && t.rt.get(x.tabId)?.targetId)
      if ((tab.loading || hasPopup || (ops.agentDriving?.(rec.nodeId) && t.state.agentTabId === tabId))) { armDiscard(rec, tabId); return }
      discardTab(rec, tabId)
    }, ops.discardMs ?? DEFAULT_DISCARD_MS))
  }
  const forgetTimers = (rec: NodeRec): void => {
    for (const k of [...discardTimers.keys()]) if (k.startsWith(`${rec.nodeId}/`)) { clearTimer(discardTimers.get(k)); discardTimers.delete(k) }
  }

  const canAdd = (rec: NodeRec): void => { if (tabsOf(rec).state.tabs.length >= MAX_TABS_PER_NODE) throw new TabLimitError(rec.nodeId) }
  const initial = (nodeId: string): PersistedTabs | undefined => validPersistedTabs(ops.initialTabs?.(nodeId))
  const forgetSaved = (nodeId: string): void => { lastSaved.delete(nodeId) }
  const title = sanitizeTabTitle

  return { ops, setTimer, clearTimer, idOf, tabsOf, find, must, emitTab, notice, flush, schedule, patchTab, setState, send, fire, stopStream, closeTarget, emulate, spawn, load, cancelDiscard, armDiscard, discardTab, forgetTimers, canAdd, initial, forgetSaved, title }
}

export type TabKit = ReturnType<typeof createKit>
