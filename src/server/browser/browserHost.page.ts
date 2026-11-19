// Page-level operations of one node that need only a CDP `send` (split out of browserHost.service.ts to keep it small):
// loading a URL and reporting a failed load, stop/reload/back/forward, and the selected text.
import type { BrowserState, NAV_ACTIONS } from '../../shared/browser.contract'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { recovering } from './browserHost.recover'
import { isAbortedNav, readHistory } from './browserHost.targets'
import type { NavGuard, NodeRec } from './browserHost.targets'

const log = createLogger('browser.host')
const TUNNEL_FAILED = /ERR_TUNNEL_CONNECTION_FAILED$/

export interface PageIo {
  send<T = Record<string, unknown>>(rec: NodeRec, method: string, params?: object): Promise<T>
  cdpOf(rec: NodeRec): Promise<CdpClient>
}

/** Page.navigate; a failed load becomes `netError` on the node (an aborted one is silent). */
export async function gotoPage(io: PageIo, guard: NavGuard, patch: (rec: NodeRec, p: Partial<BrowserState>) => void, rec: NodeRec, url: string): Promise<void> {
  const r = await io.send<{ errorText?: string }>(rec, CDP.navigate, { url })
  if (!r.errorText) return
  log.warn('browser.nav', 'navigation failed', { ids: { nodeId: rec.nodeId }, host: hostOnly(url), error: r.errorText })
  // ERR_ABORTED = stopped by the user, a download or a 204: no error page to explain. The address bar keeps the failed URL, like Chrome.
  if (isAbortedNav(r.errorText)) return
  // https through the egress proxy: its refusal of CONNECT reaches Chromium only as a tunnel failure; name the DNS case.
  const dns = TUNNEL_FAILED.test(r.errorText) && guard.onFrameNavigated(url) === 'dns_fail'
  patch(rec, { url, netError: dns ? 'net::ERR_NAME_NOT_RESOLVED' : r.errorText, loading: false })
}

/** reload / stop / back / forward of a live node. */
export async function stepPage(io: PageIo, rec: NodeRec, action: Exclude<(typeof NAV_ACTIONS)[number], 'go'>, patch: (rec: NodeRec, p: Partial<BrowserState>) => void): Promise<void> {
  if (action === 'reload') { await io.send(rec, CDP.reload); return }
  if (action === 'stop') {
    // Stop must always end the spinner: if Chromium cannot stop the page (gone, not active) the node's own flag is cleared anyway.
    try { await io.send(rec, CDP.stopLoading) } catch (err) {
      log.warn('browser.nav', 'stop loading failed; clearing the loading flag', { ids: { nodeId: rec.nodeId }, error: err instanceof Error ? err.message : String(err) })
    }
    patch(rec, { loading: false })
    return
  }
  const h = await readHistory(recovering(await io.cdpOf(rec), rec.targetId), rec.sessionId as string)
  const entryId = action === 'back' ? h.entryIds.prev : h.entryIds.next
  if (entryId !== undefined) await io.send(rec, CDP.navigateToHistoryEntry, { entryId })
}

/** Text the user has selected in the page. */
export async function selectedText(io: PageIo, rec: NodeRec): Promise<string> {
  const r = await io.send<{ result?: { value?: unknown } }>(rec, CDP.evaluate, { expression: 'String(window.getSelection())', returnByValue: true })
  return typeof r.result?.value === 'string' ? r.result.value : ''
}
