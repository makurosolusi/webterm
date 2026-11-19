// Containment guard: every page Chromium opens on its own (context menu "Open link in new tab/window", middle or
// Ctrl/Cmd+click, `target=_blank` with noopener) must end up as a tab of the node that caused it, or be closed. Nothing
// may live on as a stray Chromium tab/window on the user's machine (a Chrome-branded window outside the canvas).
// Why: a headful Chromium shows its OWN native context menu for a forwarded right click, and the tabs it opens from that
// menu have no `openerId` (like `noopener`), so the popup route never saw them. Not verifiable without a real Chromium:
// that the native menu itself is gone (it is not suppressed here; only what it opens is contained).
import { MAX_TABS_PER_NODE, TAB_LIMIT_REASON } from '../../shared/browser.tabs'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import type { HostEvent, NodeRec, TargetTable } from './browserHost.targets'

const log = createLogger('browser.containment')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const CONTAIN_GRACE_MS = 1_200 // a page nobody claimed within this time is a stray
export const GESTURE_WINDOW_MS = 5_000 // a right/middle/Ctrl click this recent explains a stray when no window matches
export const BLOCKED_OUTSIDE_NOTICE = 'Blocked a window that tried to open outside the canvas'

/** Page targets we created ourselves (tabs, probes): never strays. Cleared when the target is destroyed. */
const ownTargets = new Set<string>()
export const markOwnTarget = (targetId: string): void => { ownTargets.add(targetId) }
export const releaseTarget = (targetId: string): void => { ownTargets.delete(targetId) }

export interface StrayInfo { targetId: string; type: string; url: string }

export interface ContainOps {
  table: TargetTable
  cdpOf(rec: NodeRec): Promise<CdpClient>
  /** Shields verdict for a popup url (true = allowed). */
  popupAllowed(rec: NodeRec, url: string): boolean
  /** Open the url as a tab of the node (the guard runs inside). */
  openTab(rec: NodeRec, url: string, afterTabId?: string): Promise<unknown>
  notice(rec: NodeRec, message: string): void
  now(): number
  graceMs?: number
}

const tabTargets = (rec: NodeRec): Array<{ targetId: string; tabId?: string }> => [
  ...(rec.targetId ? [{ targetId: rec.targetId, tabId: rec.tabs?.state.activeTabId ?? undefined }] : []),
  ...[...(rec.tabs?.rt.entries() ?? [])].flatMap(([tabId, rt]) => (rt.targetId ? [{ targetId: rt.targetId, tabId }] : [])),
]

export function createContainment(ops: ContainOps) {
  const { table } = ops
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const latest = new Map<string, StrayInfo>()
  const gestures = new Map<string, number>()

  const claimed = (id: string): boolean => ownTargets.has(id) || !!table.target(id) || !!table.bgTarget(id)

  /** A mouse press that makes Chromium open something by itself: right, middle, or Ctrl/Cmd+click. */
  function noteInput(nodeId: string, ev: BrowserInputEvent): void {
    if (ev.t !== 'mouse' || ev.type !== 'down') return
    if (ev.button === 'right' || ev.button === 'middle' || (ev.mods & 6) !== 0) gestures.set(nodeId, ops.now())
  }

  /** The node whose Chromium window holds `strayId`, plus any rec on the connection that knows the target. */
  async function ownerOf(strayId: string): Promise<{ conn?: NodeRec; owner?: { rec: NodeRec; tabId?: string } }> {
    const recs = [...table.nodes.values()].filter((r) => r.targetId)
    const windowOf = async (rec: NodeRec, targetId: string): Promise<number | undefined> => {
      const r = await (await ops.cdpOf(rec)).send<{ windowId?: number }>(CDP.getWindowForTarget, { targetId })
      return r.windowId
    }
    for (const conn of recs) {
      let wid: number | undefined
      try { wid = await windowOf(conn, strayId) } catch { continue } // not this connection's browser: Chromium says "no target"
      if (wid === undefined) return { conn }
      for (const rec of recs.filter((r) => r.profileId === conn.profileId)) {
        for (const t of tabTargets(rec)) {
          try { if (await windowOf(conn, t.targetId) === wid) return { conn, owner: { rec, tabId: t.tabId } } } catch (err) {
            log.debug('browser.containment', 'window lookup of a tab failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) })
          }
        }
      }
      return { conn }
    }
    return {}
  }

  const recentGesture = (profileId: string): NodeRec | undefined => {
    let best: NodeRec | undefined
    for (const rec of table.nodes.values()) {
      const at = gestures.get(rec.nodeId)
      if (rec.profileId === profileId && at !== undefined && ops.now() - at <= GESTURE_WINDOW_MS && (!best || at > (gestures.get(best.nodeId) ?? 0))) best = rec
    }
    return best
  }

  async function settle(id: string): Promise<void> {
    const info = latest.get(id)
    timers.delete(id)
    latest.delete(id)
    if (!info || claimed(id)) return
    const { conn, owner: byWindow } = await ownerOf(id)
    if (!conn) return // not in any live browser (already gone)
    if (claimed(id)) return
    const owner = byWindow ?? (() => { const r = recentGesture(conn.profileId); return r ? { rec: r, tabId: undefined as string | undefined } : undefined })()
    const host = hostOnly(info.url)
    let closed = false
    try { await (await ops.cdpOf(conn)).send(CDP.closeTarget, { targetId: id }); closed = true } catch (err) {
      log.warn('browser.containment', 'closing a stray page failed', { ids: { nodeId: conn.nodeId }, host, error: errMsg(err) })
    }
    if (!owner || !info.url || /^(about|chrome):/i.test(info.url) || !ops.popupAllowed(owner.rec, info.url)) {
      log.warn('browser.containment', 'blocked a page that tried to open outside the canvas', { ids: { nodeId: (owner?.rec ?? conn).nodeId }, host })
      for (const r of owner ? [owner.rec] : [...table.nodes.values()].filter((x) => x.profileId === conn.profileId)) ops.notice(r, BLOCKED_OUTSIDE_NOTICE)
      return
    }
    if ((owner.rec.tabs?.state.tabs.length ?? 0) >= MAX_TABS_PER_NODE) { ops.notice(owner.rec, `${TAB_LIMIT_REASON}; a link that tried to open a window was dropped`); return }
    try {
      await ops.openTab(owner.rec, info.url, owner.tabId)
      log.info('browser.containment', 'moved a stray page into a tab of its node', { ids: { nodeId: owner.rec.nodeId }, host, closed })
    } catch (err) {
      log.warn('browser.containment', 'opening a stray page as a tab failed', { ids: { nodeId: owner.rec.nodeId }, host, error: errMsg(err) })
      ops.notice(owner.rec, BLOCKED_OUTSIDE_NOTICE)
    }
  }

  /** A page target nobody owns yet (no opener, not ours): re-checked after a short grace, then contained. */
  function stray(info: StrayInfo): void {
    if (info.type !== 'page' || claimed(info.targetId)) return
    latest.set(info.targetId, info)
    if (timers.has(info.targetId)) return
    const t = setTimeout(() => { settle(info.targetId).catch((err) => log.warn('browser.containment', 'containing a stray page failed', { error: errMsg(err) })) }, ops.graceMs ?? CONTAIN_GRACE_MS)
    t.unref?.()
    timers.set(info.targetId, t)
  }

  function gone(targetId: string): void {
    const t = timers.get(targetId)
    if (t) clearTimeout(t)
    timers.delete(targetId)
    latest.delete(targetId)
    releaseTarget(targetId)
  }

  function dispose(): void { for (const t of timers.values()) clearTimeout(t); timers.clear(); latest.clear() }

  return { stray, gone, noteInput, dispose }
}

export type Containment = ReturnType<typeof createContainment>

/** The host's wiring of the guard: notices go out as `tabNotice`, a rescued page opens as a human tab after its opener tab. */
export function createHostContainment(h: { table: TargetTable; cdpOf: ContainOps['cdpOf']; popupAllowed: ContainOps['popupAllowed']; newTab: (nodeId: string, req: { url: string; afterTabId?: string; by: 'human' }) => Promise<unknown>; emit: (e: HostEvent) => void; now?: () => number; graceMs?: number }): Containment {
  return createContainment({
    table: h.table, cdpOf: h.cdpOf, popupAllowed: h.popupAllowed, graceMs: h.graceMs, now: h.now ?? Date.now,
    openTab: (r, url, afterTabId) => h.newTab(r.nodeId, { url, afterTabId, by: 'human' }),
    notice: (r, message) => h.emit({ k: 'tabNotice', nodeId: r.nodeId, message }),
  })
}
