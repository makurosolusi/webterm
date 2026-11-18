import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '../../../../shared/browser.contract'
import type { BrowserTabsState } from '../../../../shared/browser.tabs'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { BROWSER_ACT_FLAG, createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

let f: Fixture
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db); unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: id, nodes: [{ id: 'b1', kind: 'browser' }, { id: 'b2', kind: 'browser' }] } : null)) })
afterEach(() => { unregister(); f.close() })

const ENV = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
const st = (id: string): BrowserState => ({ id, url: 'https://a.test/', title: 'A', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
const tab = (tabId: string, title: string, url: string) => ({ tabId, title, url, loading: false, discarded: false, crashed: false })
const TABS: BrowserTabsState = { tabs: [tab('t1', 'Page A', 'https://a.test/x?secret=1'), tab('t2', 'Page B', 'https://b.test/')], activeTabId: 't1', agentTabId: 't2', closed: [] }

type Reply = { status: number; body?: unknown }
function rig(reply: (verb: string, body: Record<string, unknown>) => Reply = () => ({ status: 200, body: { ok: true, data: {} } }), withTabs = true) {
  const calls: Array<{ node: string; verb: string; body: Record<string, unknown> }> = []
  const control = vi.fn(async (node: string, verb: string, body: Record<string, unknown>) => { calls.push({ node, verb, body }); return reply(verb, body) })
  const deps: BrowserToolDeps = {
    state: (id) => st(id), listDomains: () => [], control: control as BrowserToolDeps['control'],
    ...(withTabs ? { tabs: (id: string) => (id === 'b1' ? TABS : undefined) } : {}),
  }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const ctx: ToolCtx = { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env: ENV }
  return { calls, registry, run: (tool: string, args: Record<string, unknown>) => execTool(ctx, tool, { projectId: 'p1', ...args }) }
}

const LIST = { tabs: [{ id: 't1', title: 'Page A', host: 'a.test', active: true, agent: false, state: 'ready' }], agentTab: 't1', max: 8 }

describe('browser_tab', () => {
  it('is R1, registered only when the runtime can list tabs', () => {
    expect(rig().registry.get('browser_tab')?.tier).toBe('R1')
    expect(rig(undefined, false).registry.get('browser_tab')).toBeUndefined()
  })

  it('list reads the tabs through the control `tabs` verb and answers untrusted-web data', async () => {
    const s = rig(() => ({ status: 200, body: { ok: true, data: LIST } }))
    const r = await s.run('browser_tab', { nodeId: 'b1', action: 'list' })
    expect(r).toMatchObject({ ok: true, data: { nodeId: 'b1', action: 'list', agentTab: 't1', max: 8, provenance: 'untrusted-web' } })
    expect(s.calls).toEqual([{ node: 'b1', verb: 'tabs', body: {} }])
  })

  it('new / switch / close map to the `tab` verb; the note comes back; the url is audited as a host only', async () => {
    const s = rig(() => ({ status: 200, body: { ok: true, data: { ...LIST, note: 'Opened a new tab t3: B; you are now on it.', tab: LIST.tabs[0] } } }))
    const made = await s.run('browser_tab', { nodeId: 'b1', action: 'new', url: 'https://b.test/page?token=SECRET' })
    expect(made).toMatchObject({ ok: true, data: { host: 'b.test', note: expect.stringContaining('you are now on it') } })
    expect(JSON.stringify(made)).not.toContain('SECRET')
    await s.run('browser_tab', { nodeId: 'b1', action: 'switch', tab: 't2' })
    await s.run('browser_tab', { nodeId: 'b1', action: 'close', tab: 't2' })
    expect(s.calls.map((c) => [c.verb, c.body])).toEqual([
      ['tab', { action: 'new', url: 'https://b.test/page?token=SECRET' }], ['tab', { action: 'switch', tab: 't2' }], ['tab', { action: 'close', tab: 't2' }],
    ])
  })

  it.each([
    { action: 'switch' }, { action: 'close' }, { action: 'new', tab: 't2' }, { action: 'list', url: 'https://a.test/' }, { action: 'list', tab: 't1' },
    { action: 'switch', tab: '../x' }, { action: 'new', url: 'file:///etc/passwd' }, { action: 'new', url: 'javascript:1' }, { action: 'open' }, { action: 'list', extra: 1 },
  ])('rejects the invalid shape %j before any request', async (extra) => {
    const s = rig()
    expect(await s.run('browser_tab', { nodeId: 'b1', ...extra })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(s.calls).toEqual([])
  })

  it('a node of another project is node_not_found', async () => {
    const s = rig()
    expect(await s.run('browser_tab', { nodeId: 'b9', action: 'list' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(s.calls).toEqual([])
  })

  it('the tab limit refusal keeps its code and carries the next step, so the model is not stuck', async () => {
    const s = rig(() => ({ status: 409, body: { error: 'tab_limit', message: 'Tab limit (8) reached', next: 'close a tab first (tab close <id>), or work in another browser node' } }))
    const r = await s.run('browser_tab', { nodeId: 'b1', action: 'new', url: 'https://x.test/' })
    expect(r).toMatchObject({ ok: false, code: 'tab_limit', data: { next: expect.stringContaining('close a tab first') } })
  })
})

describe('browser_act with a tab', () => {
  it('forwards `tab`, and a click that opened a tab returns newTab and the note', async () => {
    const s = rig(() => ({ status: 200, body: { ok: true, data: { ok: true, newTab: 't3', note: 'Opened a new tab t3: B; you are now on it.' } } }))
    const r = await s.run('browser_act', { nodeId: 'b1', action: 'click', ref: 'e1', snapId: 's1', tab: 't2' })
    expect(r).toMatchObject({ ok: true, data: { newTab: 't3', note: expect.stringContaining('t3') } })
    expect(s.calls[0]).toMatchObject({ verb: 'click', body: { ref: 'e1', snapId: 's1', tab: 't2' } })
    await s.run('browser_act', { nodeId: 'b1', action: 'navigate', url: 'https://a.test/', tab: 't2' })
    expect(s.calls[1]).toMatchObject({ verb: 'navigate', body: { tab: 't2' } })
  })

  it('without `tab` the body is unchanged, and a malformed tab is an invalid shape', async () => {
    const s = rig()
    await s.run('browser_act', { nodeId: 'b1', action: 'click', ref: 'e1', snapId: 's1' })
    expect(s.calls[0].body).toEqual({ ref: 'e1', snapId: 's1' })
    expect(await s.run('browser_act', { nodeId: 'b1', action: 'click', ref: 'e1', snapId: 's1', tab: 'a b' })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })

  it('stale_tab_ref comes back with its next step', async () => {
    const s = rig(() => ({ status: 409, body: { error: 'stale_tab_ref', next: 'snapshot tab t2 first, then use the refs and snapId it returns' } }))
    const r = await s.run('browser_act', { nodeId: 'b1', action: 'click', ref: 'e1', snapId: 's1' })
    expect(r).toMatchObject({ ok: false, code: 'stale_tab_ref', data: { next: expect.stringContaining('snapshot tab t2') } })
  })
})

describe('browser_status shows tabs', () => {
  it('a node with several tabs lists them (host only, agent tab marked); a one-page node lists none', async () => {
    const s = rig()
    const r = await s.run('browser_status', {})
    const items = (r.data as { items: Array<{ id: string; tabs: Array<{ id: string; host: string; agent: boolean }> }> }).items
    expect(items.find((i) => i.id === 'b1')?.tabs).toMatchObject([{ id: 't1', host: 'a.test', agent: false }, { id: 't2', host: 'b.test', agent: true }])
    expect(items.find((i) => i.id === 'b2')?.tabs).toEqual([])
    expect(JSON.stringify(r)).not.toContain('secret=1')
  })
})
