// Favicon tracking of tabs: when a page finishes loading (or its <link rel=icon> changes) the tab's icon is read from
// the page through CDP, picked (shared `pickFavicon`), fetched by the profile's own Chromium and stored on the tab as a
// small data URI (`faviconData`, runtime only). See docs/decisions/browser-favicons.md.
import { pickFavicon } from '../../shared/browser.favicon'
import type { IconLink } from '../../shared/browser.favicon'
import type { BrowserTab } from '../../shared/browser.tabs'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import { createFaviconCache, FAVICON_CACHE_TTL_MS } from './browser.favicon.cache'
import type { FaviconCache } from './browser.favicon.cache'
import { fetchFavicon, iconHost } from './browser.favicon.fetch'
import { faviconAllowed } from './browser.favicon.policy'
import { FAVICON_BINDING, READ_ICON_LINKS } from './browser.favicon.script'
import type { NavGuard, NodeRec } from './browserHost.targets'

const log = createLogger('browser.favicon')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Quiet time after the last trigger before a tab's icon is read (a page that swaps its icon in bursts costs one read). */
export const FAVICON_DEBOUNCE_MS = 500
/** At most this many icon reads per tab in the window; a page that changes its icon every second is read once per window. */
export const FAVICON_RATE_MAX = 6
export const FAVICON_RATE_WINDOW_MS = 60_000
export { FAVICON_CACHE_TTL_MS }

export interface FaviconDeps {
  guard: NavGuard
  tab(rec: NodeRec, tabId: string): BrowserTab | undefined
  /** CDP session of the tab's page; undefined when it has none (discarded, crashed). */
  sessionOf(rec: NodeRec, tabId: string): string | undefined
  patch(rec: NodeRec, tabId: string, patch: Partial<Omit<BrowserTab, 'tabId'>>): void
  send(rec: NodeRec, sessionId: string, method: string, params?: object): Promise<Record<string, unknown>>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(h: unknown): void
  now?: () => number
  cache?: FaviconCache
}

interface TabFav { timer?: unknown; seq: number; lastUrl?: string; force: boolean; stamps: number[] }

export function createFavicons(d: FaviconDeps) {
  const now = d.now ?? Date.now
  const cache = d.cache ?? createFaviconCache(now)
  const tabs = new Map<string, TabFav>() // `${nodeId}/${tabId}`
  const bound = new Map<string, Set<string>>() // nodeId -> sessions that have the binding
  const keyOf = (rec: NodeRec, tabId: string) => `${rec.nodeId}/${tabId}`
  const stateOf = (k: string): TabFav => { let s = tabs.get(k); if (!s) { s = { seq: 0, force: false, stamps: [] }; tabs.set(k, s) } return s }

  async function ensureBinding(rec: NodeRec, sid: string): Promise<void> {
    const set = bound.get(rec.nodeId) ?? new Set<string>()
    bound.set(rec.nodeId, set)
    if (set.has(sid)) return
    await d.send(rec, sid, CDP.addBinding, { name: FAVICON_BINDING })
    set.add(sid)
  }

  async function readLinks(rec: NodeRec, sid: string): Promise<IconLink[]> {
    const r = await d.send(rec, sid, CDP.evaluate, { expression: READ_ICON_LINKS, returnByValue: true }) as { result?: { value?: unknown } }
    try {
      const v = JSON.parse(typeof r.result?.value === 'string' ? r.result.value : '[]') as unknown
      return Array.isArray(v) ? v.filter((l): l is IconLink => typeof l?.rel === 'string' && typeof l?.href === 'string') : []
    } catch (err) {
      throw new Error(`the page's icon list is not JSON: ${errMsg(err)}`)
    }
  }

  const clear = (rec: NodeRec, tabId: string): void => d.patch(rec, tabId, { favicon: '', faviconData: '' })

  async function run(rec: NodeRec, tabId: string, k: string): Promise<void> {
    const s = stateOf(k)
    const tab = d.tab(rec, tabId)
    const sid = d.sessionOf(rec, tabId)
    if (!tab || !sid) return
    const cutoff = now() - FAVICON_RATE_WINDOW_MS
    s.stamps = s.stamps.filter((t) => t > cutoff)
    if (s.stamps.length >= FAVICON_RATE_MAX) { // over the rate: look again once the oldest read leaves the window
      s.timer = d.setTimer(() => { s.timer = undefined; void run(rec, tabId, k) }, s.stamps[0] + FAVICON_RATE_WINDOW_MS - now() + 1)
      return
    }
    s.stamps.push(now())
    const seq = ++s.seq
    const force = s.force
    s.force = false
    const send = (m: string, p?: object) => d.send(rec, sid, m, p)
    try {
      await ensureBinding(rec, sid)
      const href = pickFavicon(await readLinks(rec, sid), tab.url)
      if (seq !== s.seq) return
      if (!href) { clear(rec, tabId); return }
      if (!href.startsWith('data:') && !faviconAllowed(href, tab.url, d.guard)) { // an inline icon makes no request, so there is nothing to guard
        log.warn('browser.favicon.refused', 'icon url refused by the navigation policy', { ids: { nodeId: rec.nodeId }, host: iconHost(href) })
        clear(rec, tabId)
        return
      }
      let data = force ? undefined : cache.get(rec.profileId, href)
      if (data === undefined) {
        data = await fetchFavicon(send, href, force)
        cache.set(rec.profileId, href, data)
      }
      if (seq !== s.seq) return // a newer read of this tab started meanwhile
      d.patch(rec, tabId, { favicon: /^https?:/i.test(href) ? href : '', faviconData: data ?? '' })
    } catch (err) {
      log.warn('browser.favicon.read', 'reading a tab icon failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) })
    }
  }

  /** Read the tab's icon after a quiet period; `force` skips the cache and the HTTP cache (the page was reloaded). */
  function request(rec: NodeRec, tabId: string, force = false): void {
    const k = keyOf(rec, tabId)
    const s = stateOf(k)
    if (force) s.force = true
    if (s.timer !== undefined) d.clearTimer(s.timer)
    s.timer = d.setTimer(() => { s.timer = undefined; void run(rec, tabId, k) }, FAVICON_DEBOUNCE_MS)
  }

  return {
    request,
    /** The tab's page finished loading: a load of the same url as last time is a reload, which forces a fresh fetch. */
    loaded(rec: NodeRec, tabId: string): void {
      const tab = d.tab(rec, tabId)
      if (!tab) return
      const s = stateOf(keyOf(rec, tabId))
      const reload = s.lastUrl === tab.url
      s.lastUrl = tab.url
      request(rec, tabId, reload)
    },
    /** `Runtime.bindingCalled` from a page: its icon links changed. */
    binding(rec: NodeRec, tabId: string, p: Record<string, unknown>): void {
      if (p.name === FAVICON_BINDING) request(rec, tabId)
    },
    /** The tab is gone: its timers and counters go too. */
    dropTab(rec: NodeRec, tabId: string): void {
      const k = keyOf(rec, tabId)
      const s = tabs.get(k)
      if (s?.timer !== undefined) d.clearTimer(s.timer)
      tabs.delete(k)
    },
    /** The node lost its pages (or is gone): timers and session bookkeeping are cleared; the tabs keep their last icon. */
    dropNode(rec: NodeRec): void {
      bound.delete(rec.nodeId)
      for (const [k, s] of tabs) if (k.startsWith(`${rec.nodeId}/`)) { if (s.timer !== undefined) d.clearTimer(s.timer); tabs.delete(k) }
    },
    cache,
  }
}

export type Favicons = ReturnType<typeof createFavicons>
