// Agent verbs work in the agent's tab (`agentTabId`), which may differ from the tab the human views. This adapter routes the
// host calls the verbs make (input, cdp, state, navigate) to that tab, and reports a tab a click opened as `newTab`.
// Nodes with one tab (or whose agent tab is the view) take the unchanged host path.
import type { BrowserHostApi } from '../../shared/browser.contract'
import type { BrowserHost } from './browserHost.service'
import type { BaseVerbs } from './browserAgent.verbs.ctx'

/** How long a click waits for a popup tab to appear before it reports none. */
export const NEW_TAB_WAIT_MS = 300

/** Host the verbs use: per-tab when the agent's tab is not the human's view. */
export function agentTabHost(host: BrowserHost): BrowserHostApi {
  const api = host.tabApi
  const away = (nodeId: string): string | undefined => {
    const a = api.agentTab(nodeId)
    return a !== undefined && a !== api.viewTab(nodeId) ? a : undefined
  }
  return new Proxy(host as BrowserHostApi, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target)
      if (typeof v !== 'function') return v
      const base = v.bind(target) as (...a: unknown[]) => unknown
      switch (prop) {
        case 'input': return (id: string, ev: never) => { const t = away(id); return t ? api.inputOnTab(id, t, ev) : base(id, ev) }
        case 'cdp': return (id: string, m: string, p?: object) => { const t = away(id); return t ? api.cdpOnTab(id, t, m, p) : base(id, m, p) }
        case 'navigate': return (id: string, url: string) => { const t = away(id); return t ? api.navigateTab(id, t, url) : base(id, url) }
        case 'state': return (id: string) => { const t = away(id); return (t && api.stateOfTab(id, t)) || base(id) }
        default: return base
      }
    },
  })
}

/**
 * `click` that opens a popup/new tab: the popup adoption moves the agent's cursor there (the click runs while the agent
 * holds the lease) and the result names it as `newTab`. Old clients ignore the extra field.
 */
export function withNewTab(verbs: BaseVerbs, host: BrowserHost): BaseVerbs {
  return {
    ...verbs,
    async click(nodeId, body) {
      const before = new Set(host.tabApi.state(nodeId)?.tabs.map((t) => t.tabId))
      const res = await verbs.click(nodeId, body)
      const deadline = Date.now() + NEW_TAB_WAIT_MS
      for (;;) {
        const fresh = host.tabApi.state(nodeId)?.tabs.find((t) => !before.has(t.tabId))
        if (fresh) return { ...res, newTab: fresh.tabId }
        if (Date.now() >= deadline) return res
        await new Promise((r) => setTimeout(r, 25))
      }
    },
  }
}
