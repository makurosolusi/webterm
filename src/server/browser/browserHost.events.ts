// Routing event CDP -> perubahan state node (navigasi, loading, dialog, crash, popup, frame screencast).
// Dipisah dari `browserHost.service.ts` (Rule 8); semua efek lewat `RouterOps` yang disediakan host.
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP, CDP_EVENT } from './cdp.client'
import type { CdpHandler } from './cdp.client'
import { isInternalUrl, popupOf, pushFrame } from './browserHost.targets'
import type { HostEvent, NavGuard, NodeRec, TargetTable } from './browserHost.targets'

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
  navigate(nodeId: string, url: string): Promise<void>
  closeTarget(opener: NodeRec, targetId: string): Promise<void>
}

/** Pembuat handler `'*'` untuk satu koneksi CDP; popup yang belum punya URL diingat per router. */
export function createEventRouter(ops: RouterOps): CdpHandler {
  const popups = new Map<string, NodeRec>()
  const { table } = ops

  const crashTarget = (targetId: unknown) => {
    const rec = table.target(targetId)
    if (rec) ops.crash(rec)
  }

  const onFrameNavigated = (rec: NodeRec, p: Record<string, unknown>) => {
    const f = p.frame as { parentId?: string; url?: string } | undefined
    if (!f?.url || f.parentId || isInternalUrl(f.url)) return // hanya frame utama; halaman internal dilewati
    const reason = ops.guard.onFrameNavigated(f.url)
    if (reason) {
      ops.patch(rec, { blocked: reason })
      ops.fire(rec, CDP.navigate, { url: 'about:blank' })
      log.warn('browser.block', 'frame navigation blocked', { ids: { nodeId: rec.nodeId }, host: hostOnly(f.url), reason })
      return
    }
    ops.patch(rec, { url: f.url, blocked: undefined })
    void ops.refresh(rec)
  }

  /** Popup (`window.open`) -> navigasi di node pembuka (P-8); judul node ikut `targetInfoChanged`. */
  const onTargetInfo = (p: Record<string, unknown>, created: boolean) => {
    const info = p.targetInfo as { targetId: string; type: string; title: string; url: string; openerId?: string } | undefined
    if (!info) return
    const owner = table.target(info.targetId)
    if (owner) {
      if (!created) ops.patch(owner, { title: info.title })
      return
    }
    const pop = popupOf(table, popups, created, info)
    if (!pop) return
    const nodeId = pop.opener.nodeId
    ops.closeTarget(pop.opener, info.targetId)
      .catch((err) => log.warn('browser.popup', 'closing popup failed', { ids: { nodeId }, error: errMsg(err) }))
    ops.navigate(nodeId, pop.url).catch((err) => {
      if (!(err instanceof BlockedError)) log.warn('browser.popup', 'popup navigation failed', { ids: { nodeId }, error: errMsg(err) })
    })
  }

  return (p, sessionId, method) => {
    const rec = table.session(sessionId)
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
      case CDP_EVENT.dialogOpening:
        if (rec) ops.emit({ k: 'dialog', nodeId: rec.nodeId, kind: p.type as 'alert', message: String(p.message ?? ''), defaultPrompt: typeof p.defaultPrompt === 'string' ? p.defaultPrompt : undefined })
        return
      case CDP_EVENT.inspectorCrashed: return rec && ops.crash(rec)
      case CDP_EVENT.targetCrashed: return crashTarget(p.targetId)
      case CDP_EVENT.targetDestroyed:
        popups.delete(String(p.targetId))
        return crashTarget(p.targetId)
      case CDP_EVENT.targetCreated: return onTargetInfo(p, true)
      case CDP_EVENT.targetInfoChanged: return onTargetInfo(p, false)
    }
  }
}
