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
beforeEach(() => {
  f = openFixture(); seedPortfolio(f.db)
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: id, nodes: [{ id: 'b1', kind: 'browser', profileId: 'prof-a' }, { id: 'b2', kind: 'browser', profileId: 'prof-b' }, { id: 'a1', kind: 'agentChat' }] } : null))
})
afterEach(() => { unregister(); f.close() })

const ENV = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
const st = (id: string): BrowserState => ({ id, url: 'https://a.test/', title: 'A', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
const dl = (id: string, o: Record<string, unknown> = {}) => ({ id, name: `${id}.pdf`, state: 'completed', bytes: 10, total: 10, host: 'h.example', risky: false, ...o })
const REPLIES: Record<string, { status: number; body?: unknown }> = {
  b1: { status: 200, body: { ok: true, data: { downloads: [dl('d2'), dl('d1', { name: 'x'.repeat(300) })], note: 'n' } } },
  b2: { status: 200, body: { ok: true, data: { downloads: [dl('e1', { risky: true })], note: 'n' } } },
}

function rig(replies: Record<string, { status: number; body?: unknown }> = REPLIES) {
  const calls: Array<{ node: string; verb: string; body: Record<string, unknown> }> = []
  const control = vi.fn(async (node: string, verb: string, body: Record<string, unknown>) => { calls.push({ node, verb, body }); return replies[node] ?? { status: 404, body: { error: 'not_found' } } })
  const profiles = { list: () => [{ id: 'prof-a', name: 'Work', color: 'blue', live: true, nodeCount: 1 }, { id: 'prof-b', name: 'Bank', color: 'red', live: true, nodeCount: 1 }], resolve: () => undefined, create: () => ({ ok: false as const, code: 'x' }) }
  const deps: BrowserToolDeps = { state: (id) => st(id), listDomains: () => [], control: control as BrowserToolDeps['control'], profiles: profiles as unknown as BrowserToolDeps['profiles'] }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const ctx: ToolCtx = { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env: ENV }
  return { calls, registry, run: (args: Record<string, unknown>) => execTool(ctx, 'browser_downloads', { projectId: 'p1', ...args }) }
}

describe('browser_downloads', () => {
  it('is R0 (read-only, no approval) and only ever sends the metadata `downloads` verb with an empty body', async () => {
    const s = rig()
    expect(s.registry.get('browser_downloads')?.tier).toBe('R0')
    await s.run({})
    expect(s.calls).toEqual([{ node: 'b1', verb: 'downloads', body: {} }, { node: 'b2', verb: 'downloads', body: {} }])
  })

  it('lists metadata with node and profile name, clips page-controlled names, and labels the data untrusted', async () => {
    const r = await rig().run({})
    expect(r).toMatchObject({ ok: true, data: { total: 3, provenance: 'untrusted-web', nextOffset: null, skipped: [] } })
    const items = (r as unknown as { data: { items: Array<Record<string, unknown>> } }).data.items
    expect(items.map((i) => [i.id, i.nodeId, i.profile])).toEqual([['d2', 'b1', 'Work'], ['d1', 'b1', 'Work'], ['e1', 'b2', 'Bank']])
    expect((items[1].name as string).length).toBeLessThanOrEqual(120)
    expect(items[2]).toMatchObject({ risky: true, state: 'completed', bytes: 10 })
    expect(JSON.stringify(r)).not.toMatch(/path|text|content/)
  })

  it('filters by node and by profile (name, any case), and pages', async () => {
    const s = rig()
    expect(((await s.run({ nodeId: 'b2' })) as unknown as { data: { total: number } }).data.total).toBe(1)
    expect(s.calls.map((c) => c.node)).toEqual(['b2'])
    const byProfile = await rig().run({ profile: 'work' })
    expect(((byProfile as unknown as { data: { items: Array<{ nodeId: string }> } }).data.items).every((i) => i.nodeId === 'b1')).toBe(true)
    const page = await rig().run({ limit: 1, offset: 1 }) as unknown as { data: { items: unknown[]; nextOffset: number } }
    expect(page.data.items).toHaveLength(1)
    expect(page.data.nextOffset).toBe(2)
  })

  it('refuses a node that is not a browser of the project, a bad shape and any extra key (no `read`, no path)', async () => {
    const s = rig()
    expect(await s.run({ nodeId: 'a1' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await s.run({ nodeId: 'zz' })).toMatchObject({ ok: false, code: 'node_not_found' })
    for (const bad of [{ read: 'd1' }, { limit: 0 }, { profile: '' }, { nodeId: 'a b' }]) expect(await s.run(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await s.run({ path: '/x' })).toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
  })

  it('a node that refuses (agent control off) is reported under `skipped`, the others still answer', async () => {
    const r = await rig({ ...REPLIES, b1: { status: 403, body: { error: 'disabled' } } }).run({})
    expect(r).toMatchObject({ ok: true, data: { total: 1, skipped: [{ nodeId: 'b1', code: 'disabled' }] } })
  })
})
