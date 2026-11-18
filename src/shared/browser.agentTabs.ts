// What an agent sees of a node's tabs: a compact, text-only view (no favicon, no full URL) shared by the control verbs
// (`tabs`, snapshot header) and Central's `browser_status`. Pure; titles are page content, so callers keep them inside
// the untrusted wrapper or the tool's `provenance: untrusted-web`.
import { hostOnly } from './browser.url'
import type { BrowserTab, BrowserTabsState } from './browser.tabs'

export const AGENT_TAB_TITLE_MAX = 60
const HEADER_TITLE_MAX = 40
/** Tab ids are server-made; this is the shape any caller-supplied id must have before it is looked up. */
export const AGENT_TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type AgentTabStatus = 'ready' | 'loading' | 'discarded' | 'crashed'

export interface AgentTabView {
  id: string
  title: string
  /** Hostname only; the full URL stays on the server. */
  host: string
  /** The human is looking at this tab. */
  active: boolean
  /** This is the agent's working tab (verbs without `--tab` act here). */
  agent: boolean
  opener?: string
  state: AgentTabStatus
}

export const clipTabTitle = (s: string, max: number = AGENT_TAB_TITLE_MAX): string => {
  const t = s.replace(/[\p{Cc}\s]+/gu, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}...` : t
}

const statusOf = (t: BrowserTab): AgentTabStatus => (t.crashed ? 'crashed' : t.discarded ? 'discarded' : t.loading ? 'loading' : 'ready')

export function tabViews(s: BrowserTabsState): AgentTabView[] {
  return s.tabs.map((t) => ({
    id: t.tabId, title: clipTabTitle(t.title), host: t.url ? hostOnly(t.url) : '', active: t.tabId === s.activeTabId, agent: t.tabId === s.agentTabId,
    ...(t.openerTabId ? { opener: t.openerTabId } : {}), state: statusOf(t),
  }))
}

/** One line for the top of a snapshot when the node has more than one tab; '' for a single tab. */
export function tabHeader(s: BrowserTabsState): string {
  if (s.tabs.length < 2) return ''
  const items = s.tabs.map((t) => `${t.tabId} "${clipTabTitle(t.title, HEADER_TITLE_MAX) || '(untitled)'}"${t.tabId === s.agentTabId ? ' <- you' : ''}`)
  return `Tabs (${s.tabs.length}): ${items.join(' | ')}`
}
