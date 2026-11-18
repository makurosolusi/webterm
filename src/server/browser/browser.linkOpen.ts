// "Open this link in my canvas" for a terminal (canvas link capture, docs/decisions/canvas-link-capture.md):
// picks the browser node cabled to the origin node (or adds one beside it, cabled, no question asked), opens the
// URL as a NEW TAB the human is shown (the agent's own tab cursor is never moved), and says so in the UI.
// Pure over `LinkOpenDeps`; the runtime wires the host, the board writer and the SSRF guard (browser.runtime.ts).
import { BlockedError } from '../../shared/browser.contract'
import { hostOnly, parseBrowserUrl } from '../../shared/browser.url'
import { MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import type { LinkOpenedMsg, ViewMsg } from '../../shared/protocol'
import { createLogger } from '../logs'
import type { AgentOpened } from './browser.agentOpen'
import { isPublicWebUrl } from './browser.publicUrl'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.linkopen')

export interface LinkOpenDeps {
  /** The same navigation rules the host applies (scheme, private hosts; loopback dev servers and OAuth callbacks allowed on a loopback bind). */
  guard(url: string): { ok: true; url: string } | { ok: false; reason: string; hostname: string }
  /** Browser node cabled to `originId`, or a new one beside it (cabled, page started). */
  open(originId: string): Promise<AgentOpened>
  workspaceOf(nodeId: string): string | undefined
  tabsOf(nodeId: string): BrowserTabsState | undefined
  /** Open `url` in a new tab and show it to the human. */
  newTab(nodeId: string, url: string): Promise<void>
  /** Tab limit reached: load `url` in `tabId` and show that tab to the human. */
  reuseTab(nodeId: string, tabId: string, url: string): Promise<void>
  /** Stored preset of the origin node; set = a locked agent that may only open public pages. */
  presetOf?(nodeId: string): string | undefined
  notify(msg: LinkOpenedMsg | ViewMsg): void
}

export type LinkOpenResult = { status: number; body: Record<string, unknown> }
const refuse = (status: number, error: string, message: string): LinkOpenResult => ({ status, body: { error, message } })

const MAX_LIVE_MESSAGE = 'The live browser limit is reached. Close or hide another browser node on the canvas, then open the link again.'

/** Words for an error thrown while opening the tab; page text and URLs are never echoed. */
function describe(err: unknown): LinkOpenResult {
  if (err instanceof BlockedError) {
    return err.reason === 'max_live' ? refuse(409, 'max_live', MAX_LIVE_MESSAGE) : refuse(403, 'blocked', `The browser refused this address (${err.reason}).`)
  }
  if (err instanceof BrowserError && (err.code === 'no_binary' || err.code === 'launch_failed')) {
    return refuse(503, err.code, 'The canvas browser could not start (Chrome or Chromium is missing or failed to launch).')
  }
  log.error('browser.linkopen.fail', 'Opening a captured link failed', { error: err instanceof Error ? err.name : 'unknown' })
  return refuse(502, 'browser_failed', 'The canvas browser could not open the page. Retry once; if it repeats, check the browser node.')
}

export async function openLinkInCanvas(deps: LinkOpenDeps, originId: string, raw: unknown): Promise<LinkOpenResult> {
  const parsed = parseBrowserUrl(raw)
  if (!parsed.ok) {
    return parsed.reason === 'scheme'
      ? refuse(400, 'unsupported_scheme', 'Only http and https links open in the canvas browser.')
      : refuse(400, 'bad_url', 'The link is not a valid absolute http(s) URL.')
  }
  if (deps.presetOf?.(originId) && !isPublicWebUrl(parsed.url)) {
    return refuse(403, 'verb_not_allowed_for_preset', 'This agent may only open public web pages.')
  }
  const guard = deps.guard(parsed.url)
  if (!guard.ok) return refuse(403, 'blocked', `The browser refused this address (${guard.reason}): ${guard.hostname}.`)
  const workspaceId = deps.workspaceOf(originId)
  if (!workspaceId) return refuse(404, 'not_on_board', 'This session is not a node on any webterm board.')

  const made = await deps.open(originId)
  if (!made.ok && 'result' in made) return { status: made.result.status, body: made.result.body as Record<string, unknown> }
  const nodeId = made.nodeId
  // A failed page start still left the node on the board: the tab call below reports why (max_live, no Chromium).
  const created = !(made.ok && made.reused)
  try {
    const tabs = deps.tabsOf(nodeId)?.tabs ?? []
    const last = tabs[tabs.length - 1]
    const full = tabs.length >= MAX_TABS_PER_NODE && last !== undefined
    if (full) await deps.reuseTab(nodeId, last.tabId, guard.url)
    else await deps.newTab(nodeId, guard.url)
    const host = hostOnly(guard.url)
    // Host only: a sign-in URL carries tokens in its query, which must not reach the log or the notice.
    log.info('browser.linkopen', 'Link opened in the canvas browser', { ids: { nodeId }, origin: originId, host, created, reusedTab: full })
    deps.notify({ t: 'linkOpened', workspaceId, nodeId, host, ...(created ? { created: true } : {}) })
    deps.notify({ t: 'view', workspaceId, nodeId, polite: true })
    return { status: 200, body: { ok: true, mode: 'canvas', nodeId, created, ...(full ? { reusedTab: last.tabId, note: `All ${MAX_TABS_PER_NODE} tabs were in use, so the last tab was reused.` } : {}) } }
  } catch (err) {
    return describe(err)
  }
}
