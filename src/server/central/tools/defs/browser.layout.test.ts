import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '../../../../shared/browser.contract'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { BROWSER_ACT_FLAG, createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

let f: Fixture
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db); unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: id, nodes: [{ id: 'b1', kind: 'browser' }] } : null)) })
afterEach(() => { unregister(); f.close() })

const ENV = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
const st = (id: string): BrowserState => ({ id, url: 'https://a.test/', title: 'A', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })

type Reply = { status: number; body?: unknown }
function rig(reply: (verb: string, body: Record<string, unknown>) => Reply = () => ({ status: 200, body: { ok: true, data: {} } }), withTabs = true) {
  const calls: Array<{ node: string; verb: string; body: Record<string, unknown> }> = []
  const control = vi.fn(async (node: string, verb: string, body: Record<string, unknown>) => { calls.push({ node, verb, body }); return reply(verb, body) })
  const deps: BrowserToolDeps = { state: (id) => st(id), listDomains: () => [], control: control as BrowserToolDeps['control'], ...(withTabs ? { tabs: () => undefined } : {}) }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const ctx: ToolCtx = { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env: ENV }
  return { calls, registry, run: (args: Record<string, unknown>) => execTool(ctx, 'browser_layout', { projectId: 'p1', ...args }) }
}
const LAYOUT = { tree: 'h(t1, t2)', split: true, sync: false, maxPanes: 4, panes: [{ tab: 't1', title: 'A', host: 'a.test', focus: true, w: 400, h: 300 }, { tab: 't2', title: 'B', host: 'b.test', focus: false, w: 400, h: 300 }] }

describe('browser_layout', () => {
  it('is R1 and registered with the tab tools only', () => {
    expect(rig().registry.get('browser_layout')?.tier).toBe('R1')
    expect(rig(undefined, false).registry.get('browser_layout')).toBeUndefined()
  })

  it('get reads the layout through the `layout` verb and answers untrusted-web data', async () => {
    const s = rig(() => ({ status: 200, body: { ok: true, data: LAYOUT } }))
    const r = await s.run({ nodeId: 'b1', action: 'get' })
    expect(r).toMatchObject({ ok: true, data: { nodeId: 'b1', action: 'get', tree: 'h(t1, t2)', provenance: 'untrusted-web' } })
    expect(s.calls).toEqual([{ node: 'b1', verb: 'layout', body: {} }])
  })

  it('set maps to `arrange` with the spec; sync maps to `sync`', async () => {
    const s = rig(() => ({ status: 200, body: { ok: true, data: { ...LAYOUT, note: 'Layout set: 2 pane(s).' } } }))
    expect(await s.run({ nodeId: 'b1', action: 'set', spec: 'h t1 new:https://b.test/' })).toMatchObject({ ok: true, data: { note: 'Layout set: 2 pane(s).' } })
    await s.run({ nodeId: 'b1', action: 'sync', on: true })
    expect(s.calls.map((c) => [c.verb, c.body])).toEqual([['arrange', { spec: 'h t1 new:https://b.test/' }], ['sync', { on: true }]])
  })

  it('all runs navigate / scroll / reload on every tab and passes the per-tab results through; the url is audited as a host only', async () => {
    const results = [{ tab: 't1', ok: true }, { tab: 't2', ok: false, error: 'crashed' }]
    const s = rig(() => ({ status: 200, body: { ok: true, data: { all: true, results, okCount: 1, failedCount: 1 } } }))
    const r = await s.run({ nodeId: 'b1', action: 'all', verb: 'navigate', url: 'https://b.test/p?token=SECRET' })
    expect(r).toMatchObject({ ok: true, data: { host: 'b.test', okCount: 1, failedCount: 1, results } })
    expect(JSON.stringify(r)).not.toContain('SECRET')
    await s.run({ nodeId: 'b1', action: 'all', verb: 'scroll', dy: 300 })
    await s.run({ nodeId: 'b1', action: 'all', verb: 'reload' })
    expect(s.calls.map((c) => [c.verb, c.body])).toEqual([['navigate', { all: true, url: 'https://b.test/p?token=SECRET' }], ['scroll', { all: true, dy: 300 }], ['reload', { all: true }]])
  })

  it.each([
    [{ action: 'get', spec: 'h a b' }], [{ action: 'set' }], [{ action: 'set', spec: 'grid a b c' }], [{ action: 'set', spec: 'h a new:file:///etc/passwd' }],
    [{ action: 'sync' }], [{ action: 'sync', on: 'yes' }], [{ action: 'all' }],
    [{ action: 'all', verb: 'click' }], [{ action: 'all', verb: 'type' }], // the approval of browser_act is not bypassed here
    [{ action: 'all', verb: 'navigate' }], [{ action: 'all', verb: 'navigate', url: 'javascript:alert(1)' }], [{ action: 'all', verb: 'scroll', dy: 0 }],
    [{ action: 'all', verb: 'scroll', dy: 99999 }], [{ action: 'all', verb: 'reload', url: 'https://a.test/' }], [{ action: 'get', extra: 1 }], [{ action: 'zap' }],
  ])('refuses the bad shape %j before any control call', async (args) => {
    const s = rig()
    expect(await s.run({ nodeId: 'b1', ...args })).toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
  })

  it('refuses a node that is not a browser node of the project, and maps a control failure to a code and next step', async () => {
    const s = rig(() => ({ status: 409, body: { error: 'tab_limit', next: 'close a tab first' } }))
    expect(await s.run({ nodeId: 'zz', action: 'get' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await s.run({ nodeId: 'b1', action: 'set', spec: 'h t1 new:https://b.test/' })).toMatchObject({ ok: false, data: { next: 'close a tab first' } })
  })
})
