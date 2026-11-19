// The canvas browser's own context menu, server half. A forwarded right click would make Chromium show its NATIVE menu,
// whose "Open link in new tab/window" escapes the canvas. So the right button is never forwarded: the host hit-tests the
// point in the page (after giving the site its own `contextmenu` event, so Figma/Docs-style menus keep working) and tells
// the client what is under the pointer; the client draws the menu and every action stays on the canvas.
// Middle and Ctrl/Cmd+click on a link are forwarded (the page script cancels Chromium's own tab open, see the script file)
// while the host opens the link as a tab of the node. Everything the page returns is untrusted: sanitized, rate limited.
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { sanitizeContext, webUrl } from '../../shared/browser.contextmenu'
import type { ContextInfo } from '../../shared/browser.contextmenu'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import type { CdpClient } from './cdp.client'
import { hitExpression } from './browserHost.contextMenu.script'
import type { HostEvent, NodeRec } from './browserHost.targets'

const log = createLogger('browser.contextmenu')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** At most this many hit-tests per node in the window: a script flooding synthetic input cannot make the host evaluate unboundedly. */
export const CTX_RATE_MAX = 8
export const CTX_RATE_WINDOW_MS = 2_000
const MODS_CTRL_META = 6 // CDP modifiers: Ctrl = 2, Meta = 4

export interface ContextMenuOps {
  cdpOf(rec: NodeRec): Promise<CdpClient>
  /** CDP session of the pane the input is for (absent = the view page); undefined = no live page. */
  sessionOf(rec: NodeRec, tabId?: string): Promise<string | undefined>
  emit(e: HostEvent): void
  /** Open the url as a tab of the node, after `afterTabId` (the tab guard runs inside). */
  newTab(nodeId: string, req: { url: string; afterTabId?: string; by: 'human' }): Promise<unknown>
  now(): number
}

export function createContextMenu(ops: ContextMenuOps) {
  const stamps = new Map<string, number[]>()

  const allowed = (nodeId: string): boolean => {
    const t = ops.now()
    const recent = (stamps.get(nodeId) ?? []).filter((x) => t - x < CTX_RATE_WINDOW_MS)
    const ok = recent.length < CTX_RATE_MAX
    if (ok) recent.push(t)
    stamps.set(nodeId, recent)
    return ok
  }

  /** Hit-test the point; the page's answer is parsed here and only sanitized fields leave. */
  async function hit(rec: NodeRec, ev: { x: number; y: number; tab?: string }, fire: boolean): Promise<{ custom: boolean; info: ContextInfo | null }> {
    const sid = await ops.sessionOf(rec, ev.tab)
    if (!sid) return { custom: false, info: null }
    const r = await (await ops.cdpOf(rec)).send<{ result?: { value?: unknown } }>(CDP.evaluate, { expression: hitExpression(ev.x, ev.y, fire), returnByValue: true }, sid)
    const raw = r.result?.value
    if (typeof raw === 'string' && /^\{"custom":true\}$/.test(raw)) return { custom: true, info: null }
    return { custom: false, info: sanitizeContext(raw) }
  }

  async function showMenu(rec: NodeRec, ev: { x: number; y: number; tab?: string }): Promise<void> {
    const { custom, info } = await hit(rec, ev, true)
    if (!custom && info) ops.emit({ k: 'contextMenu', nodeId: rec.nodeId, tab: ev.tab, info })
  }

  async function openLinkAt(rec: NodeRec, ev: { x: number; y: number; tab?: string }): Promise<void> {
    const { info } = await hit(rec, ev, false)
    if (info?.link) await ops.newTab(rec.nodeId, { url: info.link.href, afterTabId: ev.tab, by: 'human' })
  }

  function run(rec: NodeRec, what: string, task: Promise<void>, notice?: string): void {
    task.catch((err) => {
      log.warn('browser.contextmenu', `${what} failed`, { ids: { nodeId: rec.nodeId }, error: errMsg(err) })
      if (notice) ops.emit({ k: 'tabNotice', nodeId: rec.nodeId, message: notice })
    })
  }

  return {
    /** True = the event must NOT reach Chromium (the right button: it would raise the native menu). */
    intercept(rec: NodeRec, ev: BrowserInputEvent): boolean {
      if (ev.t !== 'mouse' || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return false
      if (ev.button === 'right') {
        if (ev.type === 'down' && allowed(rec.nodeId)) run(rec, 'showing the context menu', showMenu(rec, ev))
        return true // down, up and anything else of the right button
      }
      const opensTab = ev.type === 'down' && (ev.button === 'middle' || (ev.button === 'left' && (ev.mods & MODS_CTRL_META) !== 0))
      if (opensTab && allowed(rec.nodeId)) run(rec, 'opening a link as a tab', openLinkAt(rec, ev), 'That link could not be opened as a tab')
      return false
    },

    /** Client action "Open link in new tab". The url was validated by the wire parser; it is checked again here (second boundary). */
    async openLink(nodeId: string, url: string, afterTabId?: string): Promise<void> {
      const safe = webUrl(url)
      if (!safe) throw new Error(`open link in tab: refused a non-http(s) address for node ${nodeId}`)
      await ops.newTab(nodeId, { url: safe, afterTabId, by: 'human' })
    },
  }
}

export type ContextMenu = ReturnType<typeof createContextMenu>
