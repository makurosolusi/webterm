// Agent verbs for the tabs of one browser node: `tabs` (list), `tab new|switch|close`, and `--tab <id>` on every page verb.
// The tab model and CDP effects live in the host (`host.tabApi`); this layer only validates the agent's input, moves the
// agent's cursor (`agentTabId`) and words the answers so the model is never stuck (every refusal says what to do next).
import { AGENT_TAB_ID_RE, clipTabTitle, tabHeader, tabViews } from '../../shared/browser.agentTabs'
import type { TabsData } from '../../shared/browser.contract'
import { MAX_TABS_PER_NODE, TAB_LIMIT_REASON } from '../../shared/browser.tabs'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import { hostOnly } from '../../shared/browser.url'
import type { AgentVerbs, BaseVerbs } from './browserAgent.verbs.ctx'
import { asRecord, badRequest } from './browserAgent.verbs.ctx'
import { UNTRUSTED_OPEN, stripMarkers } from './browserAgent.wrap'
import type { BrowserHost } from './browserHost.service'
import { BrowserError } from './browserHost.targets'
import { TabLimitError } from './browserHost.tabs'
import type { LeaseService } from './browserLease.service'

/** A refusal with its own wire code and a concrete next step (`next`), e.g. `stale_tab_ref`, `tab_limit`, `unknown_tab`. */
export class AgentTabError extends BrowserError {
  constructor(readonly wire: string, readonly status: number, message: string, readonly next: string) {
    super('bad_request', message)
    this.name = 'AgentTabError'
  }
}

export interface TabVerbDeps {
  host: BrowserHost
  leases: Pick<LeaseService, 'acquire'>
  agentAllowed(nodeId: string): boolean
  sleep(ms: number): Promise<void>
}

/** Verbs whose body may carry `tab`; the others (`open`, `handoff`, `release`, `tabs`, `tab`) never do. */
const PAGE_VERBS = ['status', 'snapshot', 'screenshot', 'wait', 'console', 'navigate', 'click', 'type', 'press', 'scroll'] as const
/** Verbs that carry a snapshot ref/snapId or wait on one; a ref is only valid in the tab its snapshot was taken in. */
const REF_VERBS = new Set<string>(['click', 'type', 'wait'])
const NO_TABS = 'This browser has no open page yet. Run navigate <url> first, then list its tabs.'

export function withTabs(base: BaseVerbs, deps: TabVerbDeps): AgentVerbs {
  const { host } = deps
  const api = host.tabApi
  /** Tab each node's latest snapshot was taken in (the store keeps one snapshot per node, so one entry per node). */
  const snapTab = new Map<string, { snapId: string; tabId: string }>()

  const stateOf = (nodeId: string): BrowserTabsState => {
    const s = api.state(nodeId)
    if (!s) throw new BrowserError('not_found', `node ${nodeId}: ${NO_TABS}`)
    return s
  }
  const data = (nodeId: string): TabsData => {
    const s = stateOf(nodeId)
    return { tabs: tabViews(s), agentTab: s.agentTabId, max: MAX_TABS_PER_NODE }
  }
  const needId = (v: unknown, field = 'tab'): string => {
    if (typeof v !== 'string' || !AGENT_TAB_ID_RE.test(v)) throw badRequest(`${field} must be a tab id like t3 (see the tabs verb)`)
    return v
  }
  const known = (nodeId: string, tabId: string): void => {
    if (!stateOf(nodeId).tabs.some((t) => t.tabId === tabId)) {
      throw new AgentTabError('unknown_tab', 404, `node ${nodeId}: no tab ${tabId}`, 'list the tab ids with the tabs verb and use one of them')
    }
  }
  /** Make `tabId` the agent's working tab (no-op when it already is). The human's view follows only by the host's follow-agent rule. */
  const select = async (nodeId: string, tabId: string): Promise<void> => {
    known(nodeId, tabId)
    if (api.agentTab(nodeId) !== tabId) await api.activate(nodeId, tabId, 'agent')
  }
  const staleRef = (nodeId: string, snapId: string | undefined, cur: string): void => {
    const snap = snapTab.get(nodeId)
    if (!snap || snap.tabId === cur || (snapId !== undefined && snap.snapId !== snapId)) return
    throw new AgentTabError('stale_tab_ref', 409, `node ${nodeId}: that snapshot was taken in tab ${snap.tabId}, but you are working in tab ${cur}`, `snapshot tab ${cur} first, then use the refs and snapId it returns`)
  }
  const titleOf = (nodeId: string, tabId: string): string => {
    const t = stateOf(nodeId).tabs.find((x) => x.tabId === tabId)
    return t ? clipTabTitle(t.title) || (t.url ? hostOnly(t.url) : '') : ''
  }

  /** A page verb with `--tab`: select that tab, hand the inner verb a body without it, then add tab info to the answer. */
  const onTab = <V extends (typeof PAGE_VERBS)[number]>(name: V): AgentVerbs[V] => (async (nodeId: string, raw: unknown) => {
    const body = asRecord(raw)
    const { tab, ...rest } = body
    if (tab !== undefined) await select(nodeId, needId(tab))
    const cur = api.agentTab(nodeId)
    if (cur && REF_VERBS.has(name)) staleRef(nodeId, typeof rest.snapId === 'string' ? rest.snapId : undefined, cur)
    const res = await (base[name] as (n: string, b: unknown) => Promise<Record<string, unknown>>)(nodeId, rest)
    if (name === 'snapshot') return withHeader(nodeId, cur, res)
    if (name === 'click' && typeof res.newTab === 'string') return { ...res, note: `Opened a new tab ${res.newTab}${titleOf(nodeId, res.newTab) ? `: ${titleOf(nodeId, res.newTab)}` : ''}; you are now on it.` }
    return res
  }) as AgentVerbs[V]

  /** Snapshot: remember its tab (for stale_tab_ref) and, for a node with several tabs, list them at the top, inside the untrusted block (titles are page text). */
  function withHeader(nodeId: string, cur: string | undefined, res: Record<string, unknown>): Record<string, unknown> {
    if (cur && typeof res.snapId === 'string') snapTab.set(nodeId, { snapId: res.snapId, tabId: cur })
    const s = api.state(nodeId)
    const header = s ? tabHeader(s) : ''
    const content = typeof res.content === 'string' && header ? res.content.replace(`${UNTRUSTED_OPEN}\n`, `${UNTRUSTED_OPEN}\n${stripMarkers(header)}\n`) : res.content
    return { ...res, content, ...(cur ? { tab: cur } : {}) }
  }

  const pages = Object.fromEntries(PAGE_VERBS.map((v) => [v, onTab(v)])) as Pick<AgentVerbs, (typeof PAGE_VERBS)[number]>

  return {
    ...base,
    ...pages,
    async tabs(nodeId) {
      return data(nodeId)
    },
    async tab(nodeId, raw) {
      const body = asRecord(raw)
      const action = body.action
      if (action !== 'new' && action !== 'switch' && action !== 'close') throw badRequest('action must be new, switch or close')
      await deps.leases.acquire(nodeId, deps.agentAllowed(nodeId), deps.sleep)
      if (action === 'new') {
        if (body.url !== undefined && (typeof body.url !== 'string' || body.url === '')) throw badRequest('url must be an http(s) URL')
        try {
          const made = await api.newTab(nodeId, { by: 'agent', ...(typeof body.url === 'string' ? { url: body.url } : {}) })
          const title = titleOf(nodeId, made.tabId)
          return { ...data(nodeId), tab: tabViews(stateOf(nodeId)).find((t) => t.id === made.tabId), note: `Opened a new tab ${made.tabId}${title ? `: ${title}` : ''}; you are now on it.` }
        } catch (err) {
          if (err instanceof TabLimitError) throw new AgentTabError('tab_limit', 409, `node ${nodeId}: ${TAB_LIMIT_REASON}`, 'close a tab first (tab close <id>), or work in another browser node')
          throw err
        }
      }
      const tabId = needId(body.tab)
      known(nodeId, tabId)
      if (action === 'switch') {
        await select(nodeId, tabId)
        return { ...data(nodeId), tab: tabViews(stateOf(nodeId)).find((t) => t.id === tabId), note: `You are now on tab ${tabId}.` }
      }
      await api.closeTab(nodeId, tabId)
      const left = api.state(nodeId)
      const now = left?.agentTabId
      return { ...data(nodeId), note: `Closed tab ${tabId}.${now ? ` You are now on tab ${now}.` : ' No tabs are left; open one with tab new <url>.'}` }
    },
  }
}
