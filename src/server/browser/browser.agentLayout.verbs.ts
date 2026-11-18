// Agent verbs for the split layout of one browser node: `layout` (read), `arrange` (set a shape), `sync` (mode on/off),
// `reload`/`back`/`forward` per tab, and `--all` on the page verbs: one action on every tab the layout shows, answered PER TAB
// (a tab that fails never fails the others). Tabs stay the unit an agent addresses; panes are only where the human sees them.
import { AGENT_TAB_ID_RE, clipTabTitle } from '../../shared/browser.agentTabs'
import type { AllData, LayoutData, TabResult } from '../../shared/browser.contract'
import { BlockedError } from '../../shared/browser.contract'
import { MAX_PANES, layoutTabIds } from '../../shared/browser.layout'
import { describeLayout, layoutFromSpec, parseLayoutSpec } from '../../shared/browser.layoutSpec'
import { MAX_TABS_PER_NODE, TAB_LIMIT_REASON } from '../../shared/browser.tabs'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import { hostOnly } from '../../shared/browser.url'
import { createLogger } from '../logs'
import { clickTarget, typeTarget } from './browser.semantic'
import type { SemanticOutcome, TabIo } from './browser.semantic'
import { AgentTabError } from './browser.agentTabs.verbs'
import type { AgentVerbs, TabbedVerbs } from './browserAgent.verbs.ctx'
import { asRecord, badRequest, needString } from './browserAgent.verbs.ctx'
import { CDP } from './cdp.client'
import type { BrowserHost } from './browserHost.service'
import { BrowserError } from './browserHost.targets'
import { TabLimitError } from './browserHost.tabs'
import type { LeaseService } from './browserLease.service'

const log = createLogger('browser.layout')
/** Smaller frames when several tabs answer at once: four full-size JPEGs in one reply would drown the model. */
export const ALL_SHOT_WIDTH = 800
const NO_PAGE = 'This browser has no open page yet. Run navigate <url> first.'
const ALL_VERBS = ['navigate', 'snapshot', 'screenshot', 'scroll', 'click', 'type', 'reload', 'back', 'forward'] as const
type AllVerb = (typeof ALL_VERBS)[number]
/** Raw, loosely typed call of a verb (the `all` runner builds bodies per tab). */
type Call = (nodeId: string, body: unknown) => Promise<Record<string, unknown>>

export interface LayoutVerbDeps {
  host: BrowserHost
  leases: Pick<LeaseService, 'acquire'>
  agentAllowed(nodeId: string): boolean
  sleep(ms: number): Promise<void>
}

export function withLayout(inner: TabbedVerbs, deps: LayoutVerbDeps): AgentVerbs {
  const { host } = deps
  const api = host.tabApi
  const state = (nodeId: string): BrowserTabsState => {
    const s = api.state(nodeId)
    if (!s) throw new BrowserError('not_found', `node ${nodeId}: ${NO_PAGE}`)
    return s
  }
  const lease = (nodeId: string) => deps.leases.acquire(nodeId, deps.agentAllowed(nodeId), deps.sleep)
  const tabOf = (s: BrowserTabsState, tabId: string) => s.tabs.find((t) => t.tabId === tabId)
  const known = (nodeId: string, tabId: string): void => {
    if (!tabOf(state(nodeId), tabId)) throw new AgentTabError('unknown_tab', 404, `node ${nodeId}: no tab ${tabId}`, 'list the tab ids with the tabs verb and use one of them')
  }
  /** Tabs the layout shows (reading order); without a split, the one visible tab. */
  const shown = (s: BrowserTabsState): string[] => (s.layout ? layoutTabIds(s.layout) : s.activeTabId ? [s.activeTabId] : [])
  const titleOf = (s: BrowserTabsState, id: string): string => { const t = tabOf(s, id); return t ? clipTabTitle(t.title) || (t.url ? hostOnly(t.url) : '') : '' }

  function layoutData(nodeId: string): LayoutData {
    const s = state(nodeId)
    const ids = shown(s)
    return {
      tree: s.layout ? describeLayout(s.layout) : ids[0] ?? '', split: !!s.layout, sync: host.syncOn(nodeId), maxPanes: MAX_PANES,
      panes: ids.map((id) => {
        const t = tabOf(s, id)
        const size = api.paneSize(nodeId, id) ?? { w: 0, h: 0 }
        return { tab: id, title: titleOf(s, id), host: t?.url ? hostOnly(t.url) : '', focus: id === s.activeTabId, ...size, ...(t?.device ? { device: t.device.id } : {}) }
      }),
    }
  }

  /** The tab a per-tab verb acts on: `tab` (which also becomes the working tab) or the current working tab. */
  async function target(nodeId: string, body: Record<string, unknown>): Promise<string> {
    if (body.tab !== undefined) {
      if (typeof body.tab !== 'string' || !AGENT_TAB_ID_RE.test(body.tab)) throw badRequest('tab must be a tab id like t3 (see the tabs verb)')
      known(nodeId, body.tab)
      if (api.agentTab(nodeId) !== body.tab) await api.activate(nodeId, body.tab, 'agent')
      return body.tab
    }
    const cur = api.agentTab(nodeId) ?? api.viewTab(nodeId)
    if (!cur) throw new BrowserError('not_found', `node ${nodeId}: ${NO_PAGE}`)
    return cur
  }

  /** reload / back / forward of one tab through the host's per-tab CDP. */
  async function step(nodeId: string, tab: string, what: 'reload' | 'back' | 'forward'): Promise<void> {
    if (what === 'reload') { await api.reload(nodeId, tab); return }
    const h = (await api.cdpOnTab(nodeId, tab, CDP.getNavigationHistory)) as { currentIndex?: number; entries?: Array<{ id?: number }> }
    const entry = h.entries?.[(h.currentIndex ?? -1) + (what === 'back' ? -1 : 1)]
    if (entry?.id === undefined) throw new BrowserError('bad_request', `node ${nodeId}: tab ${tab} has no page to go ${what} to`)
    await api.cdpOnTab(nodeId, tab, CDP.navigateToHistoryEntry, { entryId: entry.id })
  }
  const stepVerb = (what: 'reload' | 'back' | 'forward') => async (nodeId: string, raw: unknown) => {
    const body = asRecord(raw)
    await lease(nodeId)
    await step(nodeId, await target(nodeId, body), what)
    return { ok: true as const }
  }

  const io = (nodeId: string, tab: string): TabIo => ({ cdp: (m, p) => api.cdpOnTab(nodeId, tab, m, p), input: (ev) => api.inputOnTab(nodeId, tab, ev) })
  const refused: Record<Exclude<SemanticOutcome, 'ok'>, [string, string]> = {
    no_match: ['no_match', 'No element with that role and name in this tab.'],
    cross_origin: ['blocked', 'That control submits to another origin; click it by ref in a snapshot so the user can approve.'],
  }

  /** The semantic target of a `click --all` / `type --all` body. */
  function semantic(body: Record<string, unknown>): { name: string; role?: string; nth: number } {
    const name = needString(body.name, 'name (the element\'s accessible name)', 200)
    if (body.role !== undefined && (typeof body.role !== 'string' || !/^[A-Za-z]{2,30}$/.test(body.role))) throw badRequest('role must be an accessibility role such as button, link or textbox')
    if (body.nth !== undefined && !(Number.isInteger(body.nth) && (body.nth as number) >= 1 && (body.nth as number) <= 50)) throw badRequest('nth must be an integer from 1 (the n-th element with that role and name)')
    return { name, ...(body.role === undefined ? {} : { role: body.role as string }), nth: (body.nth as number | undefined) ?? 1 }
  }

  /** One tab's part of an `all` run -> its summary fields. */
  async function oneTab(nodeId: string, tab: string, verb: AllVerb, body: Record<string, unknown>, t: ReturnType<typeof semantic> | undefined): Promise<Record<string, unknown>> {
    if (verb === 'click' || verb === 'type') {
      const url = api.stateOfTab(nodeId, tab)?.url ?? ''
      const out = verb === 'click'
        ? await clickTarget(io(nodeId, tab), t!, url, false)
        : await typeTarget(io(nodeId, tab), t!, needString(body.text, 'text'), body.submit === true, false)
      if (out !== 'ok') throw new AgentTabError(refused[out][0], out === 'no_match' ? 404 : 403, refused[out][1], 'check the element name with a snapshot of that tab')
      return { matched: true }
    }
    if (verb === 'reload' || verb === 'back' || verb === 'forward') { await step(nodeId, tab, verb); return {} }
    const res = await (inner[verb] as Call)(nodeId, { ...body, tab })
    if (verb === 'snapshot') { const out: Record<string, unknown> = { ...res, note: 'refs are not usable after --all; snapshot one tab with --tab before clicking by ref' }; delete out.snapId; return out }
    return res.ok === true ? {} : res
  }

  const failure = (err: unknown, nodeId: string, tab: string): Pick<TabResult, 'error' | 'message'> => {
    if (err instanceof BlockedError) return { error: 'blocked', message: `blocked (${err.reason})` }
    if (err instanceof AgentTabError) return { error: err.wire, message: err.message }
    if (err instanceof BrowserError) return { error: err.code, message: err.message }
    log.error('browser.layout', 'a tab failed in an all-tab run', { ids: { nodeId }, tab, error: err instanceof Error ? err.name : 'unknown' })
    return { error: 'internal', message: 'unexpected failure in this tab' }
  }

  async function runAll(nodeId: string, verb: AllVerb, raw: Record<string, unknown>): Promise<AllData> {
    const rest = { ...raw }
    delete rest.all
    delete rest.layout
    if (rest.tab !== undefined) throw badRequest('use either --tab <id> (one tab) or --all (every tab in the layout), not both')
    const body = verb === 'screenshot' && rest.maxWidth === undefined ? { ...rest, maxWidth: ALL_SHOT_WIDTH } : rest
    const sem = verb === 'click' || verb === 'type' ? semantic(body) : undefined
    if (verb === 'click' && body.ref !== undefined) throw badRequest('click --all names the element by meaning (--text "<name>" [--role r] [--nth n]), not by ref: refs belong to one tab')
    if (verb !== 'snapshot' && verb !== 'screenshot') await lease(nodeId)
    const s = state(nodeId)
    const ids = shown(s)
    if (ids.length === 0) throw new BrowserError('not_found', `node ${nodeId}: ${NO_PAGE}`)
    const keep = api.agentTab(nodeId)
    const results: TabResult[] = []
    for (const id of ids) {
      const name = titleOf(state(nodeId), id)
      try {
        results.push({ tab: id, ok: true, name, ...(await oneTab(nodeId, id, verb, body, sem)) })
      } catch (err) {
        results.push({ tab: id, ok: false, name, ...failure(err, nodeId, id) })
      }
    }
    if (keep && api.agentTab(nodeId) !== keep && tabOf(state(nodeId), keep)) await api.activate(nodeId, keep, 'agent') // an all-run leaves the working tab where it was
    const okCount = results.filter((r) => r.ok).length
    return { all: true, results, okCount, failedCount: results.length - okCount, ...(s.layout ? {} : { note: 'No split layout: only the one visible tab ran. Use layout set to show several.' }) }
  }

  const withAll = (verb: AllVerb): ((nodeId: string, raw: unknown) => Promise<unknown>) => async (nodeId, raw) => {
    const body = asRecord(raw)
    const all = body.all === true || (verb === 'screenshot' && body.layout === true)
    if (body.all !== undefined && body.all !== true) throw badRequest('all must be true')
    if (all) return runAll(nodeId, verb, body)
    return verb === 'reload' || verb === 'back' || verb === 'forward' ? stepVerb(verb)(nodeId, body) : (inner[verb] as Call)(nodeId, body)
  }
  const wrapped = Object.fromEntries(ALL_VERBS.map((v) => [v, withAll(v)])) as unknown as Pick<AgentVerbs, AllVerb>

  return {
    ...inner,
    ...wrapped,
    async layout(nodeId) {
      return layoutData(nodeId)
    },
    async arrange(nodeId, raw) {
      const parsed = parseLayoutSpec(asRecord(raw).spec)
      if (!parsed.ok) throw badRequest(parsed.error)
      const s = state(nodeId)
      const fresh = parsed.leaves.filter((l) => 'url' in l).length
      for (const l of parsed.leaves) if ('tab' in l) known(nodeId, l.tab)
      if (s.tabs.length + fresh > MAX_TABS_PER_NODE) throw new AgentTabError('tab_limit', 409, `node ${nodeId}: ${TAB_LIMIT_REASON}; this layout opens ${fresh} new tab(s)`, 'close a tab first (tab close <id>), or reuse existing tabs')
      await lease(nodeId)
      const ids: string[] = []
      try {
        for (const l of parsed.leaves) ids.push('tab' in l ? l.tab : (await api.newTab(nodeId, { by: 'agent', url: l.url })).tabId)
      } catch (err) {
        if (err instanceof TabLimitError) throw new AgentTabError('tab_limit', 409, `node ${nodeId}: ${TAB_LIMIT_REASON}`, 'close a tab first (tab close <id>)')
        throw err
      }
      const layout = layoutFromSpec(parsed.mode, ids)
      const view = state(nodeId).activeTabId
      await api.setLayout(nodeId, layout, view && ids.includes(view) ? view : ids[0])
      return { ...layoutData(nodeId), note: `Layout set: ${ids.length} pane(s). Address a pane by its tab id (--tab <id>) or use --all.` }
    },
    async sync(nodeId, raw) {
      const on = asRecord(raw).on
      if (typeof on !== 'boolean') throw badRequest('on must be true or false')
      state(nodeId)
      host.sync.set(nodeId, on)
      return { on, note: on ? 'Sync on: what the user does in one pane repeats in every other pane. Your own commands are not mirrored; use --all.' : 'Sync off.' }
    },
  }
}
