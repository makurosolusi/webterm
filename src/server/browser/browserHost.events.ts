// Routing event CDP -> perubahan state node (navigasi, loading, dialog, crash, popup, frame screencast).
// Dipisah dari `browserHost.service.ts` (Rule 8); semua efek lewat `RouterOps` yang disediakan host.
import type { BrowserState } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, CDP_EVENT } from './cdp.client'
import type { CdpHandler } from './cdp.client'
import { isInternalUrl, popupOf, pushFrame } from './browserHost.targets'
import { markOwnTarget } from './browserHost.containment'
import type { StrayInfo } from './browserHost.containment'
import type { BgTab, HostEvent, NavGuard, NodeRec, PendingPopup, TargetTable } from './browserHost.targets'

const log = createLogger('browser.host')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface RouterOps {
  table: TargetTable
  guard: NavGuard
  patch(rec: NodeRec, part: Partial<BrowserState>): void
  emit(e: HostEvent): void
  crash(rec: NodeRec): void
  refresh(rec: NodeRec): Promise<void>
  fire(rec: NodeRec, method: string, params?: object): void
  closeTarget(opener: NodeRec, targetId: string): Promise<void>
  /** Popup sah/terblokir diputuskan Shields (true = boleh); pembuka TIDAK pernah dinavigasi ke URL popup. */
  popup(opener: NodeRec, url: string): boolean
  /** Popup yang lolos Shields menjadi tab di node pembuka (halamannya diadopsi, bukan dibuat ulang). */
  adopt(opener: NodeRec, openerTargetId: string | undefined, targetId: string, url: string): Promise<void>
  /** A tab's page closed itself (window.close()) while the node has other tabs: the tab is removed, not crashed. False = not a tab close. */
  closed(rec: NodeRec, targetId: string): boolean
  /** Tab latar: event sesi, judul, dan hilangnya halaman (tidak menjatuhkan node). */
  bgEvent(b: BgTab, method: string, p: Record<string, unknown>, sessionId: string): void
  bgTitle(b: BgTab, title: string): void
  /** A page called a CDP binding (the favicon <link> watcher): the view page's own event. */
  binding(rec: NodeRec, p: Record<string, unknown>): void
  bgGone(b: BgTab): void
  /** State Shields untuk halaman baru (hitungan direset per muat halaman, seperti Brave). */
  pageState(url: string): Partial<BrowserState>
  detached(p: Record<string, unknown>): void
  /** A page nobody owns appeared (no opener, not ours): the containment guard decides its fate (browserHost.containment.ts). */
  stray(info: StrayInfo): void
  /** A target went away: forget it in the containment guard. */
  gone(targetId: string): void
}

/** Pembuat handler `'*'` untuk satu koneksi CDP; popup yang belum punya URL diingat per router. */
export function createEventRouter(ops: RouterOps): CdpHandler {
  const popups = new Map<string, PendingPopup>()
  const { table } = ops

  const crashTarget = (targetId: unknown) => {
    const rec = table.target(targetId)
    if (rec) { ops.crash(rec); return }
    const bg = table.bgTarget(targetId)
    if (bg) ops.bgGone(bg)
  }

  const onFrameNavigated = (rec: NodeRec, p: Record<string, unknown>) => {
    const f = p.frame as { parentId?: string; url?: string; unreachableUrl?: string } | undefined
    if (f && !f.parentId && f.unreachableUrl) {
      // Chromium committed its own error page (link click, redirect, reload): CDP gives no error name here;
      // `goto` overwrites it with the exact name when the failure came from Page.navigate.
      ops.patch(rec, { url: f.unreachableUrl, netError: rec.state.netError ?? 'net::ERR_FAILED' })
      return
    }
    if (!f?.url || f.parentId || isInternalUrl(f.url)) return // hanya frame utama; halaman internal dilewati
    const reason = ops.guard.onFrameNavigated(f.url)
    if (reason === 'dns_fail') {
      // The egress proxy could not resolve the host and answered with its own 403 text: show it as the DNS
      // failure it is (error panel + Try again on this URL), not as a page.
      ops.patch(rec, { url: f.url, blocked: undefined, netError: 'net::ERR_NAME_NOT_RESOLVED' })
      return
    }
    if (reason) {
      ops.patch(rec, { blocked: reason })
      ops.fire(rec, CDP.navigate, { url: 'about:blank' })
      log.warn('browser.block', 'frame navigation blocked', { ids: { nodeId: rec.nodeId }, host: hostOnly(f.url), reason })
      return
    }
    ops.patch(rec, { url: f.url, blocked: undefined, netError: undefined, ...ops.pageState(f.url) })
    void ops.refresh(rec)
  }

  /**
   * Popup (`window.open`/`target=_blank`): Shields memutuskan; yang lolos menjadi tab baru di node pembuka (halamannya
   * diadopsi supaya `window.opener`/postMessage OAuth tetap jalan), sisanya ditutup. Pembuka tidak pernah dinavigasi ke
   * URL popup oleh kita (laporan retrogames.cc: popunder menimpa halaman pengguna).
   */
  const onTargetInfo = (p: Record<string, unknown>, created: boolean) => {
    const info = p.targetInfo as { targetId: string; type: string; title: string; url: string; openerId?: string } | undefined
    if (!info) return
    const owner = table.target(info.targetId)
    if (owner) {
      if (!created) ops.patch(owner, { title: info.title })
      return
    }
    const bg = table.bgTarget(info.targetId)
    if (bg) {
      if (!created) ops.bgTitle(bg, info.title)
      return
    }
    const pop = popupOf(table, popups, created, info)
    if (!pop) {
      if (!popups.has(info.targetId)) ops.stray({ targetId: info.targetId, type: info.type, url: info.url })
      return
    }
    markOwnTarget(info.targetId) // handed to the popup route: not a stray
    const nodeId = pop.opener.nodeId
    if (!ops.popup(pop.opener, pop.url)) {
      ops.closeTarget(pop.opener, info.targetId)
        .catch((err) => log.warn('browser.popup', 'closing popup failed', { ids: { nodeId }, error: errMsg(err) }))
      return
    }
    ops.adopt(pop.opener, pop.openerId, info.targetId, pop.url)
      .catch((err) => log.warn('browser.popup', 'adopting popup failed', { ids: { nodeId }, error: errMsg(err) }))
  }

  return (p, sessionId, method) => {
    const rec = table.session(sessionId)
    const bg = rec ? undefined : table.bgSession(sessionId)
    if (bg && sessionId) { ops.bgEvent(bg, method, p, sessionId); if (method !== CDP_EVENT.detachedFromTarget) return }
    switch (method) {
      case CDP_EVENT.screencastFrame: return rec && pushFrame(rec, p)
      case CDP_EVENT.frameNavigated: return rec && onFrameNavigated(rec, p)
      case CDP_EVENT.navigatedWithinDocument:
        if (rec && typeof p.url === 'string') { ops.patch(rec, { url: p.url }); void ops.refresh(rec) }
        return
      case CDP_EVENT.frameStartedLoading: return rec && ops.patch(rec, { loading: true })
      case CDP_EVENT.frameStoppedLoading:
        if (rec) { ops.patch(rec, { loading: false }); void ops.refresh(rec) }
        return
      case CDP_EVENT.bindingCalled: return rec && ops.binding(rec, p)
      case CDP_EVENT.dialogOpening:
        if (rec) ops.emit({ k: 'dialog', nodeId: rec.nodeId, kind: p.type as 'alert', message: String(p.message ?? ''), defaultPrompt: typeof p.defaultPrompt === 'string' ? p.defaultPrompt : undefined })
        return
      case CDP_EVENT.inspectorCrashed: return rec && ops.crash(rec)
      case CDP_EVENT.targetCrashed: return crashTarget(p.targetId)
      case CDP_EVENT.targetDestroyed: {
        popups.delete(String(p.targetId))
        ops.gone(String(p.targetId))
        const owner = table.target(p.targetId) ?? table.bgTarget(p.targetId)?.rec
        if (owner && typeof p.targetId === 'string' && ops.closed(owner, p.targetId)) return
        return crashTarget(p.targetId)
      }
      case CDP_EVENT.targetCreated: return onTargetInfo(p, true)
      case CDP_EVENT.targetInfoChanged: return onTargetInfo(p, false)
      case CDP_EVENT.detachedFromTarget: {
        // Sesi UTAMA node lepas (target ditukar/ditutup tanpa `discard`) = target hilang; `discard` unbind lebih dulu.
        const gone = typeof p.sessionId === 'string' ? p.sessionId : undefined
        const main = table.session(gone)
        const b = main ? undefined : table.bgSession(gone)
        const owner = main ?? b?.rec
        const tid = main ? main.targetId : b?.rec.tabs?.rt.get(b.tabId)?.targetId
        if (owner && tid && ops.closed(owner, tid)) return ops.detached(p)
        if (main) ops.crash(main)
        else if (b) ops.bgGone(b)
        return ops.detached(p)
      }
    }
  }
}
