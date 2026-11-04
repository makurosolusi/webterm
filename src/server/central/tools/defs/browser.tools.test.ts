import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState, BrowserVerb } from '../../../../shared/browser.contract'
import type { BrowserControlDeps } from '../../../browser/browserControl.handler'
import { BrowserError } from '../../../browser/browserHost.targets'
import type { AgentVerbs } from '../../../browser/browserAgent.verbs.ctx'
import { CapabilityStore, allows } from '../../../control/capabilities'
import { allRows } from '../../../ledger/ledgerCore'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, Tier, ToolCtx } from '../toolTypes'
import { ACT_TEXT_MAX_CHARS, BROWSER_ACT_FLAG, createBrowserDefs, createControlCaller } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

let f: Fixture
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => { unregister(); f.close() })

const ENV_ON = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
const state = (patch: Partial<BrowserState> = {}): BrowserState =>
  ({ id: 'b1', url: 'https://app.example.com/inbox?token=SECRET#frag', title: 'Inbox', loading: false, canBack: false, canForward: false, lease: 'agent', live: 'live', ...patch })

/** Workspaces live in a separate store (webterm.db) in production, never in the ledger fixture. */
const seedNodes = () => {
  const store: Record<string, unknown[]> = {
    'w-p1': [{ id: 'b1', kind: 'browser' }, { id: 't1', kind: 'terminal' }, { id: 'b2', kind: 'browser' }],
    'w-p2': [{ id: 'b9', kind: 'browser' }],
  }
  unregister = registerWorkspaceLookup((id) => (store[id] ? { name: id, nodes: store[id] } : null))
}
const audits = () => allRows(f.db, "SELECT payload_json FROM event WHERE kind = 'central.proposal' ORDER BY seq").map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>)

interface Rig { verbs: Record<string, ReturnType<typeof vi.fn>>; agentAllowed: boolean; mint(nodeId: string): string }

/** Real `handleBrowserControl` + real `CapabilityStore`; only the verbs (browser host) are faked. */
function rig(over: Partial<Record<BrowserVerb, (body: unknown) => Promise<unknown>>> = {}, opts: { agentAllowed?: boolean; mintFor?: (nodeId: string) => string } = {}) {
  const store = new CapabilityStore()
  const verbs: Record<string, ReturnType<typeof vi.fn>> = {}
  const proxy = new Proxy({} as AgentVerbs, {
    get: (_t, verb: string) => (verbs[verb] ??= vi.fn(async (_node: string, body: unknown) => (over[verb as BrowserVerb] ? over[verb as BrowserVerb]!(body) : { ok: true }))),
  })
  const control: BrowserControlDeps = {
    capabilities: { verify: (t) => store.verify(t), allows: (r, v, res) => allows(r, v, res) },
    verbs: proxy, agentAllowed: () => opts.agentAllowed ?? true,
  }
  const mint = opts.mintFor ?? ((nodeId: string) => store.mint({ verb: 'browser.act', resource: `node:${nodeId}`, ttlMs: 30_000, mintedBy: 'central' }))
  return { verbs, control: createControlCaller(control, mint), mint, store }
}

function deps(control: BrowserToolDeps['control'], extra: Partial<BrowserToolDeps> = {}): BrowserToolDeps {
  return { state: (id) => (id === 'b1' ? state() : undefined), listDomains: () => [], control, ...extra }
}

function ctx(d: BrowserToolDeps, o: { maxTier?: Tier; guard?: ControlGuard; env?: Record<string, string> } = {}): ToolCtx {
  const registry = createRegistry()
  createBrowserDefs(d).forEach((def) => registry.register(def))
  return { db: f.db, registry, guard: o.guard ?? ALLOW_ALL_GUARD, maxTier: o.maxTier ?? 'R2', conversationId: 'central:global', now: () => 1, env: o.env ?? ENV_ON }
}

describe('flags', () => {
  it('execTool reports flag_off for browser_status without its flag and for browser_act only on an explicit agent off', async () => {
    seedNodes()
    const d = deps(async () => ({ status: 200 }))
    const nav = { projectId: 'p1', nodeId: 'b1', action: 'navigate', url: 'https://a.example/' }
    expect(await execTool(ctx(d, { env: { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'off' } }), 'browser_act', nav)).toMatchObject({ ok: false, code: 'flag_off' })
    expect(await execTool(ctx(d, { env: {} }), 'browser_status', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'flag_off' })
  })
  it('agent flag unset = browser_act allowed (same default-on reader as wired agents), still subject to tier and guard', async () => {
    seedNodes()
    const d = deps(async () => ({ status: 200 }))
    const nav = { projectId: 'p1', nodeId: 'b1', action: 'navigate', url: 'https://a.example/' }
    const env = { [BROWSER_TOOLS_FLAG]: 'on' }
    expect(await execTool(ctx(d, { env }), 'browser_act', nav)).toMatchObject({ ok: true })
    expect(await execTool(ctx(d, { env, maxTier: 'R1' }), 'browser_act', nav)).toMatchObject({ ok: false, code: 'tier_denied' })
    const deny: ControlGuard = { check: () => ({ ok: false, code: 'level_denied' }) }
    expect(await execTool(ctx(d, { env, guard: deny }), 'browser_act', nav)).toMatchObject({ ok: false, code: 'level_denied' })
  })
})

describe('browser_status', () => {
  it('shows host only, never query/fragment, cookie values or extra vault fields; only this project nodes', async () => {
    seedNodes()
    const vault = [{ domain: 'app.example.com', value: 'COOKIE-SECRET', count: 3 }] as unknown as Array<{ domain: string }>
    const res = await execTool(ctx(deps(async () => ({ status: 200 }), { listDomains: (w) => (w === 'w-p1' ? vault : []) })), 'browser_status', { projectId: 'p1' })
    expect(res.ok).toBe(true)
    const data = res.data as { items: Array<Record<string, unknown>>; authenticatedDomains: string[]; total: number }
    expect(data.items.map((i) => i.id)).toEqual(['b1', 'b2'])
    expect(data.items[0]).toMatchObject({ host: 'app.example.com', lease: 'agent', live: 'live', title: 'Inbox' })
    expect(data.items[1]).toMatchObject({ host: null, lease: null })
    expect(data.authenticatedDomains).toEqual(['app.example.com'])
    const text = JSON.stringify(res)
    for (const leak of ['SECRET', 'COOKIE', 'frag', 'inbox', 'b9', '"count"']) expect(text).not.toContain(leak)
    expect(JSON.stringify(audits())).not.toContain('app.example.com/')
  })
  it('pages and clips untrusted titles; domains only on the first page', async () => {
    seedNodes()
    const d = deps(async () => ({ status: 200 }), { state: () => state({ title: 'T'.repeat(300) }), listDomains: () => [{ domain: 'x.example' }] })
    const first = (await execTool(ctx(d), 'browser_status', { projectId: 'p1', limit: 1 })).data as { items: Array<{ title: string }>; nextOffset: number | null; authenticatedDomains: string[]; provenance: string }
    expect([first.items.length, first.nextOffset, first.authenticatedDomains, first.provenance]).toEqual([1, 1, ['x.example'], 'untrusted-web'])
    expect(first.items[0]!.title.length).toBeLessThanOrEqual(80)
    const second = (await execTool(ctx(d), 'browser_status', { projectId: 'p1', limit: 1, offset: 1 })).data as { authenticatedDomains: string[]; nextOffset: number | null }
    expect([second.authenticatedDomains, second.nextOffset]).toEqual([[], null])
    expect(await execTool(ctx(d), 'browser_status', { projectId: 'p1', limit: 0 })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })
  it('coded failures without a workspace', async () => {
    const res = await execTool(ctx(deps(async () => ({ status: 200 }))), 'browser_status', { projectId: 'p1' })
    expect(res).toMatchObject({ ok: false, code: 'workspace_unavailable' })
  })
})

describe('browser_act input validation', () => {
  const base = { projectId: 'p1', nodeId: 'b1' }
  const bad: Array<[string, Record<string, unknown>]> = [
    ['javascript scheme', { action: 'navigate', url: 'javascript:alert(1)' }],
    ['file scheme', { action: 'navigate', url: 'file:///etc/passwd' }],
    ['userinfo', { action: 'navigate', url: 'https://u:p@a.example/' }],
    ['no url', { action: 'navigate' }],
    ['url too long', { action: 'navigate', url: `https://a.example/${'a'.repeat(9000)}` }],
    ['unknown action', { action: 'cdp' }],
    ['css selector instead of ref', { action: 'click', ref: '#login > button', snapId: 's1' }],
    ['ref too long', { action: 'click', ref: `e${'1'.repeat(40)}`, snapId: 's1' }],
    ['missing snapId', { action: 'click', ref: 'e1' }],
    ['text too long', { action: 'type', ref: 'e1', snapId: 's1', text: 'x'.repeat(ACT_TEXT_MAX_CHARS + 1) }],
    ['empty text', { action: 'type', ref: 'e1', snapId: 's1', text: '' }],
    ['submit not boolean', { action: 'type', ref: 'e1', snapId: 's1', text: 'a', submit: 'yes' }],
    ['stray key', { action: 'click', ref: 'e1', snapId: 's1', text: 'a' }],
    ['unsafe node id', { action: 'click', nodeId: '../x', ref: 'e1', snapId: 's1' }],
  ]
  it.each(bad)('rejects %s before any control call', async (_name, patch) => {
    seedNodes()
    const r = rig()
    const res = await execTool(ctx(deps(r.control)), 'browser_act', { ...base, ...patch })
    expect(res).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(Object.keys(r.verbs)).toEqual([])
  })
})

describe('browser_act execution', () => {
  const nav = { projectId: 'p1', nodeId: 'b1', action: 'navigate', url: 'https://docs.example.com/a?q=secret-query#h' }

  it('goes through the control handler with a node-scoped capability and normalized bodies', async () => {
    seedNodes()
    const r = rig()
    const c = ctx(deps(r.control))
    expect(await execTool(c, 'browser_act', nav)).toMatchObject({ ok: true, data: { nodeId: 'b1', action: 'navigate', host: 'docs.example.com', provenance: 'untrusted-web' } })
    expect(r.verbs.navigate).toHaveBeenCalledWith('b1', { url: 'https://docs.example.com/a?q=secret-query#h' })
    await execTool(c, 'browser_act', { projectId: 'p1', nodeId: 'b1', action: 'click', ref: 'e3', snapId: 's1' })
    await execTool(c, 'browser_act', { projectId: 'p1', nodeId: 'b2', action: 'type', ref: 'e4', snapId: 's1', text: 'hello', submit: true })
    expect(r.verbs.click).toHaveBeenCalledWith('b1', { ref: 'e3', snapId: 's1' })
    expect(r.verbs.type).toHaveBeenCalledWith('b2', { ref: 'e4', snapId: 's1', text: 'hello', submit: true })
  })

  it('lease: a node without the agent lease is refused by the control path (lease_human), not bypassed', async () => {
    seedNodes()
    const r = rig({ navigate: async () => { throw new BrowserError('lease_human', 'human holds the lease') } })
    expect(await execTool(ctx(deps(r.control)), 'browser_act', nav)).toMatchObject({ ok: false, code: 'lease_human' })
  })

  it('capability: a token for another node, or an unknown token, is refused (forbidden / unauthorized)', async () => {
    seedNodes()
    const other = rig({}, { mintFor: () => 'ignored' })
    const wrongNode = rig({}, {})
    const foreign = createControlCaller(
      { capabilities: { verify: (t) => wrongNode.store.verify(t), allows: (r, v, res) => allows(r, v, res) }, verbs: new Proxy({} as AgentVerbs, { get: () => vi.fn() }), agentAllowed: () => true },
      () => wrongNode.store.mint({ verb: 'browser.act', resource: 'node:b2' })
    )
    expect(await execTool(ctx(deps(foreign)), 'browser_act', nav)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await execTool(ctx(deps(other.control)), 'browser_act', nav)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(Object.keys(other.verbs)).toEqual([])
  })

  it('agentControl off, SSRF block and unknown node map to coded failures; nodes of another project are not reachable', async () => {
    seedNodes()
    expect(await execTool(ctx(deps(rig({}, { agentAllowed: false }).control)), 'browser_act', nav)).toMatchObject({ ok: false, code: 'disabled' })
    const blocked = rig({ navigate: async () => { throw new BrowserError('blocked', 'private host', 'internal.local') } })
    expect(await execTool(ctx(deps(blocked.control)), 'browser_act', nav)).toMatchObject({ ok: false, code: 'blocked' })
    const r = rig()
    expect(await execTool(ctx(deps(r.control)), 'browser_act', { ...nav, nodeId: 'b9' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await execTool(ctx(deps(r.control)), 'browser_act', { ...nav, nodeId: 't1' })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(Object.keys(r.verbs)).toEqual([])
  })

  it('R2 needs approval: tier above the caller and a guard demanding approval both stop the handler', async () => {
    seedNodes()
    const r = rig()
    expect(await execTool(ctx(deps(r.control), { maxTier: 'R1' }), 'browser_act', nav)).toMatchObject({ ok: false, code: 'tier_denied' })
    const needsApproval: ControlGuard = { check: (req) => (req.tier === 'R2' ? { ok: false, code: 'approval_required' } : { ok: true }) }
    expect(await execTool(ctx(deps(r.control), { guard: needsApproval }), 'browser_act', nav)).toMatchObject({ ok: false, code: 'approval_required' })
    expect(Object.keys(r.verbs)).toEqual([])
  })

  it('auditKeys carry node, action and host only: no URL, query or fragment reaches the ledger', async () => {
    seedNodes()
    const r = rig()
    await execTool(ctx(deps(r.control)), 'browser_act', nav)
    const last = audits().at(-1)!
    expect(last).toMatchObject({ tool: 'browser_act', tier: 'R2', ok: true, nodeId: 'b1', action: 'navigate', host: 'docs.example.com' })
    const text = JSON.stringify(last)
    for (const leak of ['secret-query', '?', '#', 'https://', '/a']) expect(text).not.toContain(leak)
    await execTool(ctx(deps(rig({ navigate: async () => { throw new BrowserError('lease_human', 'x') } }).control)), 'browser_act', nav)
    expect(JSON.stringify(audits().at(-1))).not.toContain('secret-query')
  })
})
