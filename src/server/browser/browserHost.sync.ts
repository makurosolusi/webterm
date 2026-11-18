// Sync mode of a split browser node: what the human does in one pane is repeated in every other pane of the node.
// Navigation (go/reload/back/forward), keys, scroll position (as a ratio) and clicks, the last matched by MEANING
// (role + accessible name + n-th, `browser.semantic.ts`) because the pages differ. A pane that has no such element
// shows "no match"; the others carry on. Session state only (never saved with the board), default off.
// Safe by construction: targets are the tabs of the SAME node (one profile) that its layout shows; nothing leaves the node.
import { MAX_PANES, layoutTabIds } from '../../shared/browser.layout'
import type { BrowserInputEvent, NAV_ACTIONS } from '../../shared/browser.contract'
import { createLogger } from '../logs'
import { AGENT_CDP } from './browserAgent.cdpAllowlist'
import type { AxNode } from './browserAgent.snapshot'
import { clickTarget, describeAt } from './browser.semantic'
import type { TabIo } from './browser.semantic'
import { CDP } from './cdp.client'
import type { TabApi } from './browserHost.tabs.api'
import { BrowserError } from './browserHost.targets'
import type { HostEvent, NodeRec, TargetTable } from './browserHost.targets'

const log = createLogger('browser.sync')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Wheel bursts settle this long before the scroll position is copied (one copy per burst, not per notch). */
export const SCROLL_SETTLE_MS = 150
export const SYNC_NEEDS_SPLIT = `Sync needs a split layout with at least 2 panes (at most ${MAX_PANES}); set one first`

const NODE_AT = 'DOM.getNodeForLocation'
const SCROLL_RATIO = '(()=>{const e=document.scrollingElement||document.documentElement;const m=e.scrollHeight-innerHeight;return m>0?e.scrollTop/m:0})()'
const scrollTo = (ratio: number): string => `(()=>{const e=document.scrollingElement||document.documentElement;const m=e.scrollHeight-innerHeight;scrollTo(0,m>0?${ratio}*m:0);return 1})()`

export interface SyncDeps { table: TargetTable; tabApi: TabApi; emit(e: HostEvent): void }

export function createSync(d: SyncDeps) {
  const on = new Set<string>()
  const tails = new Map<string, Promise<unknown>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const recOf = (nodeId: string): NodeRec | undefined => d.table.nodes.get(nodeId)
  const paneTabs = (rec: NodeRec): string[] => { const l = rec.tabs?.state.layout; return l ? layoutTabIds(l) : [] }
  const sourceOf = (rec: NodeRec, ev?: BrowserInputEvent): string | undefined => ev?.tab ?? rec.tabs?.state.activeTabId ?? undefined
  /** The other panes of the node: shown by the layout, and with a page to act on. */
  const targets = (rec: NodeRec, source: string): string[] =>
    paneTabs(rec).filter((id) => id !== source && rec.tabs?.state.tabs.some((t) => t.tabId === id && !t.crashed))
  const ioOf = (nodeId: string, tab: string): TabIo => ({
    cdp: (m, p) => d.tabApi.cdpOnTab(nodeId, tab, m, p),
    input: (ev) => d.tabApi.inputOnTab(nodeId, tab, ev),
  })
  const urlOf = (rec: NodeRec, tab: string): string => rec.tabs?.state.tabs.find((t) => t.tabId === tab)?.url ?? ''

  /** Mirrored work of one node runs in order (a click, then the keys typed after it). A failure is logged, never thrown into the human's input. */
  function queue(nodeId: string, what: string, fn: () => Promise<void>): void {
    const next = (tails.get(nodeId) ?? Promise.resolve()).then(fn).catch((err) => log.warn('browser.sync', `mirroring ${what} failed`, { ids: { nodeId }, error: errMsg(err) }))
    tails.set(nodeId, next)
  }
  const miss = (nodeId: string, tab: string, reason: 'no_match' | 'cross_origin' | 'error'): void => d.emit({ k: 'syncMiss', nodeId, tab, reason })
  /** Run `fn` on each target; one that fails is reported for its pane and the others still run. */
  async function each(rec: NodeRec, source: string, fn: (tab: string) => Promise<'ok' | 'no_match' | 'cross_origin' | void>): Promise<void> {
    for (const tab of targets(rec, source)) {
      try {
        const r = await fn(tab)
        if (r === 'no_match' || r === 'cross_origin') miss(rec.nodeId, tab, r)
      } catch (err) {
        log.warn('browser.sync', 'mirroring into a pane failed', { ids: { nodeId: rec.nodeId }, tab, error: errMsg(err) })
        miss(rec.nodeId, tab, 'error')
      }
    }
  }

  async function mirrorClick(rec: NodeRec, source: string, x: number, y: number): Promise<void> {
    const io = ioOf(rec.nodeId, source)
    const at = (await io.cdp(NODE_AT, { x: Math.round(x), y: Math.round(y) })) as { backendNodeId?: number }
    if (!Number.isInteger(at.backendNodeId)) return
    const tree = (await io.cdp(AGENT_CDP.axTree)) as { nodes?: AxNode[] }
    const target = describeAt(Array.isArray(tree.nodes) ? tree.nodes : [], at.backendNodeId as number)
    if (!target) return // nothing with a name under the pointer: there is nothing to look for elsewhere
    await each(rec, source, (tab) => clickTarget(ioOf(rec.nodeId, tab), target, urlOf(rec, tab)))
  }

  async function mirrorScroll(rec: NodeRec, source: string): Promise<void> {
    const read = (await ioOf(rec.nodeId, source).cdp(CDP.evaluate, { expression: SCROLL_RATIO, returnByValue: true })) as { result?: { value?: unknown } }
    const ratio = read.result?.value
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
    await each(rec, source, async (tab) => { await ioOf(rec.nodeId, tab).cdp(CDP.evaluate, { expression: scrollTo(Math.min(1, Math.max(0, ratio))), returnByValue: true }) })
  }

  async function history(nodeId: string, tab: string, step: -1 | 1): Promise<void> {
    const h = (await d.tabApi.cdpOnTab(nodeId, tab, CDP.getNavigationHistory)) as { currentIndex?: number; entries?: Array<{ id?: number }> }
    const entry = h.entries?.[(h.currentIndex ?? -1) + step]
    if (entry?.id !== undefined) await d.tabApi.cdpOnTab(nodeId, tab, CDP.navigateToHistoryEntry, { entryId: entry.id })
  }

  /** Turn sync on/off for a node. On needs a split of 2+ panes in a node that is open. */
  function set(nodeId: string, value: boolean): boolean {
    const rec = recOf(nodeId)
    if (value && (!rec?.tabs || paneTabs(rec).length < 2)) throw new BrowserError('bad_request', `node ${nodeId}: ${SYNC_NEEDS_SPLIT}`)
    if (on.has(nodeId) === value) return value
    if (value) on.add(nodeId)
    else { on.delete(nodeId); clearTimeout(timers.get(nodeId)); timers.delete(nodeId) }
    d.emit({ k: 'sync', nodeId, on: value })
    return value
  }

  return {
    isOn: (nodeId: string): boolean => on.has(nodeId),

    set,

    /** A human input in `ev.tab` (or the focused tab) was just sent to its page: repeat it in the other panes. */
    onInput(nodeId: string, ev: BrowserInputEvent): void {
      const rec = on.has(nodeId) ? recOf(nodeId) : undefined
      const source = rec && sourceOf(rec, ev)
      if (!rec || !source) return
      if (ev.t === 'mouse') {
        if (ev.type === 'wheel') {
          clearTimeout(timers.get(nodeId))
          timers.set(nodeId, setTimeout(() => { timers.delete(nodeId); queue(nodeId, 'scroll', () => mirrorScroll(rec, source)) }, SCROLL_SETTLE_MS))
        } else if (ev.type === 'down' && ev.button === 'left') {
          queue(nodeId, 'click', () => mirrorClick(rec, source, ev.x, ev.y))
        }
        return
      }
      if (ev.t === 'key' || ev.t === 'text' || ev.t === 'ime') queue(nodeId, 'keys', () => each(rec, source, (tab) => d.tabApi.inputOnTab(nodeId, tab, ev)))
    },

    /** A human navigation of the focused tab (address bar, back, forward, reload): repeat it in the other panes. */
    onNav(nodeId: string, action: (typeof NAV_ACTIONS)[number], url?: string): void {
      const rec = on.has(nodeId) ? recOf(nodeId) : undefined
      const source = rec?.tabs?.state.activeTabId
      if (!rec || !source || action === 'stop') return
      queue(nodeId, `nav ${action}`, () => each(rec, source, async (tab) => {
        if (action === 'go' && url) await d.tabApi.navigateTab(nodeId, tab, url)
        else if (action === 'reload') await d.tabApi.reload(nodeId, tab)
        else if (action === 'back' || action === 'forward') await history(nodeId, tab, action === 'back' ? -1 : 1)
      }))
    },

    /** Host events: the layout collapsing to one pane ends sync (an indicator for panes that no longer exist would lie). */
    onEvent(e: HostEvent): void {
      if (e.k === 'tab' && e.event.type === 'layoutChanged' && !e.event.layout && on.has(e.nodeId)) set(e.nodeId, false)
    },

    forget(nodeId: string): void {
      on.delete(nodeId)
      clearTimeout(timers.get(nodeId))
      timers.delete(nodeId)
      tails.delete(nodeId)
    },
  }
}

export type NodeSync = ReturnType<typeof createSync>
