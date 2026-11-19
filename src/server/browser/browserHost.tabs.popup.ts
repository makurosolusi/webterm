// Popups and background-tab events of the tab manager: a popup (window.open, target=_blank, OAuth) becomes a tab of its
// opener's node (the page is adopted, not recreated, so window.opener and postMessage keep working); events of tabs that
// are not the view update only their tab entry.
import { TAB_LIMIT_REASON, MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import type { BrowserTab } from '../../shared/browser.tabs'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, CDP_EVENT } from './cdp.client'
import { blockOf, isInternalUrl, readHistory } from './browserHost.targets'
import type { BgTab, NodeRec } from './browserHost.targets'
import { BACKSTOP_SCRIPT } from './browserHost.contextMenu.script'
import type { TabKit } from './browserHost.tabs.kit'
import type { Favicons } from './browserHost.favicon'

const log = createLogger('browser.tabs')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Chromium's answer when a popup closed itself (OAuth: postMessage + window.close()) before it could be attached. */
const PAGE_ALREADY_GONE = /no target with given id/i

export interface PopupDeps {
  favicons: Favicons
  create(rec: NodeRec, o: { url: string; afterTabId?: string; openerTabId?: string; focusHuman: boolean; focusAgent: boolean; adopt: () => Promise<{ targetId: string; sessionId: string }> }): Promise<BrowserTab>
  liveSession(rec: NodeRec, tabId: string): Promise<string>
  /** A frame of an on-screen tab that is not the view (split view). */
  sideFrame(rec: NodeRec, tabId: string, sessionId: string, p: Record<string, unknown>): void
}

export function createPopupSide(kit: TabKit, deps: PopupDeps) {
  const { ops, patchTab, send, fire, notice } = kit
  const { table } = ops

  const closePage = (rec: NodeRec, targetId: string): void => {
    ops.cdpOf(rec).then((c) => c.send(CDP.closeTarget, { targetId }))
      .catch((err) => log.warn('browser.popup', 'closing a refused popup failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) }))
  }

  /** Tab that owns a page of this node (view or background), by CDP target id. */
  const tabOfTarget = (rec: NodeRec, targetId: string | undefined): string | undefined => {
    if (!targetId) return undefined
    if (rec.targetId === targetId) return rec.tabs?.state.activeTabId ?? undefined
    return table.bgTarget(targetId)?.tabId
  }

  /**
   * A popup the Shields let through: adopt its page as a tab placed after its opener. CDP gives no user-gesture flag, so a
   * popup from the human's visible tab counts as the human's doing (it becomes the view, like Chrome); one from the agent's
   * working tab while the agent holds the lease counts as the agent's (its cursor moves; the view too while following).
   * Never throws: any refusal closes the popup page and says why.
   */
  async function adoptPopup(rec: NodeRec, openerTargetId: string | undefined, targetId: string, url: string): Promise<void> {
    const t = rec.tabs
    if (!t) { closePage(rec, targetId); return }
    const blocked = blockOf(ops.guard, url)
    if (blocked) {
      closePage(rec, targetId)
      notice(rec, `Popup blocked: ${blocked.host} is not allowed (${blocked.reason})`)
      return
    }
    const openerTabId = tabOfTarget(rec, openerTargetId)
    if (t.state.tabs.length >= MAX_TABS_PER_NODE) {
      closePage(rec, targetId)
      notice(rec, `${TAB_LIMIT_REASON}; the link opened in the tab that opened it`)
      if (openerTabId) {
        try { await send(rec, await deps.liveSession(rec, openerTabId), CDP.navigate, { url }) } catch (err) { log.warn('browser.popup', 'redirect to the opener tab failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) }) }
      }
      return
    }
    const byAgent = !!ops.agentDriving?.(rec.nodeId) && openerTabId !== undefined && openerTabId === t.state.agentTabId
    try {
      await deps.create(rec, {
        url, afterTabId: openerTabId, openerTabId,
        focusAgent: byAgent,
        focusHuman: byAgent ? t.followAgent : openerTabId !== undefined && openerTabId === t.state.activeTabId,
        adopt: async () => {
          const cdp = await ops.cdpOf(rec)
          const { sessionId } = await cdp.send<{ sessionId: string }>(CDP.attachToTarget, { targetId, flatten: true })
          await cdp.send(CDP.pageEnable, {}, sessionId)
          await cdp.send(CDP.addScript, { source: BACKSTOP_SCRIPT }, sessionId)
          await cdp.send(CDP.setFocusEmulation, { enabled: true }, sessionId)
          await ops.shield.enable(cdp, sessionId)
          await ops.console.enable(cdp, sessionId)
          await kit.emulate(rec, sessionId)
          return { targetId, sessionId }
        },
      })
    } catch (err) {
      if (PAGE_ALREADY_GONE.test(errMsg(err))) { log.info('browser.popup', 'popup closed itself before it became a tab', { ids: { nodeId: rec.nodeId }, host: hostOnly(url) }); return }
      closePage(rec, targetId)
      log.warn('browser.popup', 'adopting a popup as a tab failed', { ids: { nodeId: rec.nodeId }, host: hostOnly(url), error: errMsg(err) })
      notice(rec, 'A popup could not be opened as a tab')
    }
  }

  const titleOf = async (b: BgTab, sid: string): Promise<void> => {
    try {
      const h = await readHistory(await ops.cdpOf(b.rec), sid)
      patchTab(b.rec, b.tabId, { title: kit.title(h.title) })
    } catch (err) {
      log.warn('browser.tabs.title', 'reading a background tab title failed', { ids: { nodeId: b.rec.nodeId }, error: errMsg(err) })
    }
  }

  /** A background page went away without us closing it (crash/detach): its tab is marked crashed, the node is untouched. */
  function bgGone(b: BgTab): void {
    const t = b.rec.tabs
    const rt = t?.rt.get(b.tabId)
    if (!t || !rt) return
    table.bgUnbind(rt.targetId, rt.sessionId)
    t.rt.delete(b.tabId)
    patchTab(b.rec, b.tabId, { crashed: true, loading: false })
  }

  function bgTitle(b: BgTab, title: string): void { patchTab(b.rec, b.tabId, { title: kit.title(title) }) }

  /** Session events of a background tab (a view tab goes through the node router). */
  function bgEvent(b: BgTab, method: string, p: Record<string, unknown>, sessionId: string): void {
    const { rec, tabId } = b
    switch (method) {
      case CDP_EVENT.screencastFrame: return deps.sideFrame(rec, tabId, sessionId, p)
      case CDP_EVENT.frameStartedLoading: return patchTab(rec, tabId, { loading: true })
      case CDP_EVENT.frameStoppedLoading:
        patchTab(rec, tabId, { loading: false })
        void titleOf(b, sessionId)
        deps.favicons.loaded(rec, tabId)
        return
      case CDP_EVENT.bindingCalled: return deps.favicons.binding(rec, tabId, p)
      case CDP_EVENT.navigatedWithinDocument:
        if (typeof p.url === 'string') patchTab(rec, tabId, { url: p.url })
        return
      case CDP_EVENT.frameNavigated: {
        const f = p.frame as { parentId?: string; url?: string } | undefined
        if (!f?.url || f.parentId || isInternalUrl(f.url)) return
        const reason = ops.guard.onFrameNavigated(f.url)
        if (reason === 'dns_fail') return
        if (reason) {
          fire(rec, sessionId, CDP.navigate, { url: 'about:blank' })
          notice(rec, `Navigation in a background tab was blocked (${reason})`)
          return
        }
        patchTab(rec, tabId, { url: f.url })
        return
      }
      case CDP_EVENT.dialogOpening:
        fire(rec, sessionId, CDP.handleDialog, { accept: false }) // nobody can answer a dialog of a hidden tab; leaving it open would hang the page
        return
      case CDP_EVENT.inspectorCrashed: return bgGone(b)
    }
  }

  return { adoptPopup, bgEvent, bgGone, bgTitle, tabOfTarget }
}
