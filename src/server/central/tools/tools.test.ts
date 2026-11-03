import { describe, expect, it } from 'vitest'
import { allRows } from '../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { defaultRegistry } from './defaultRegistry'
import { CORE_DEFS } from './defs/core.defs'
import { ALLOW_ALL_GUARD, execTool } from './toolExec'
import { CATALOG_TOKEN_BUDGET, createRegistry, estimateTokens, renderCatalog, toolsHash } from './toolRegistry'
import { TIER_ORDER, type ControlGuard, type Tier, type ToolCtx, type ToolDef, type ToolRegistry } from './toolTypes'

function fake(name: string, tier: Tier, extra: Partial<ToolDef> = {}): ToolDef {
  return { name, summary: `fake ${name}`, tier, usage: `{"projectId":"<id>"} for ${name}`, validate: () => null, handler: () => ({ ok: true, data: { taskId: 't-1' } }), auditKeys: ['taskId'], ...extra }
}
function fixture(): Fixture { const f = openFixture(); seedPortfolio(f.db); return f }
function ctxOf(f: Fixture, registry: ToolRegistry, maxTier: Tier, guard: ControlGuard = ALLOW_ALL_GUARD, extra: Partial<ToolCtx> = {}): ToolCtx {
  return { db: f.db, registry, guard, maxTier, conversationId: 'global', now: () => 1_700_000_000_000, ...extra }
}
const audits = (f: Fixture) => allRows(f.db, "SELECT payload_json FROM event WHERE kind = 'central.proposal' ORDER BY seq").map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>)

describe('registry', () => {
  it('rejects duplicate names and over-long summaries, lists and gets', () => {
    const reg = createRegistry()
    reg.register(fake('a.one', 'R0'))
    expect(() => reg.register(fake('a.one', 'R1'))).toThrow(/already registered: a.one/)
    expect(() => reg.register(fake('a.two', 'R0', { summary: 'x'.repeat(121) }))).toThrow(/summary/)
    expect(reg.list().map((d) => d.name)).toEqual(['a.one'])
    expect(reg.get('a.one')?.tier).toBe('R0')
    expect(reg.get('missing')).toBeUndefined()
  })
  it('default registry holds the four core tools, all R1', () => {
    expect(defaultRegistry().list().map((d) => d.name).sort()).toEqual(['approval.request', 'goal.propose', 'plan.propose', 'task.assign'])
    expect(CORE_DEFS.every((d) => d.tier === 'R1')).toBe(true)
  })
  it('toolsHash is stable across registration order and changes with content', () => {
    const defs = [fake('a', 'R0'), fake('b', 'R1'), fake('c', 'R2')]
    const make = (order: ToolDef[]) => { const r = createRegistry(); order.forEach((d) => r.register(d)); return r }
    const h1 = toolsHash(make(defs))
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(toolsHash(make([...defs].reverse()))).toBe(h1)
    expect(toolsHash(make([defs[1]!, defs[2]!, defs[0]!]))).toBe(h1)
    expect(toolsHash(make([defs[0]!, defs[1]!, fake('c', 'R3')]))).not.toBe(h1)
    expect(toolsHash(make([defs[0]!, defs[1]!, fake('c', 'R2', { usage: 'changed' })]))).not.toBe(h1)
  })
})

describe('renderCatalog', () => {
  it('renders the core catalog within the token budget', () => {
    const text = renderCatalog(defaultRegistry(), 'R1')
    for (const name of ['goal.propose', 'plan.propose', 'task.assign', 'approval.request']) expect(text).toContain(`${name} {"projectId":"<id>"`)
    expect(estimateTokens(text)).toBeLessThanOrEqual(CATALOG_TOKEN_BUDGET)
  })
  it('filters by tier and flag, and stays under budget with many tools', () => {
    const reg = createRegistry()
    reg.register(fake('r0.tool', 'R0'))
    reg.register(fake('r2.tool', 'R2'))
    reg.register(fake('flagged.tool', 'R0', { flag: 'WEBTERM_TEST_FLAG' }))
    expect(renderCatalog(reg, 'R0', {})).toContain('r0.tool')
    expect(renderCatalog(reg, 'R1', {})).not.toContain('r2.tool')
    expect(renderCatalog(reg, 'R2', {})).toContain('r2.tool')
    expect(renderCatalog(reg, 'R0', {})).not.toContain('flagged.tool')
    expect(renderCatalog(reg, 'R0', { WEBTERM_TEST_FLAG: 'on' })).toContain('flagged.tool')
    for (let i = 0; i < 300; i++) reg.register(fake(`bulk.tool${i}`, 'R0'))
    const big = renderCatalog(reg, 'R3', {})
    expect(estimateTokens(big)).toBeLessThanOrEqual(CATALOG_TOKEN_BUDGET)
    expect(big).toContain('r0.tool')
  })
})

describe('execTool tier matrix', () => {
  const cases: Array<[Tier, Tier, boolean]> = []
  for (const tool of TIER_ORDER) for (const max of TIER_ORDER) cases.push([tool, max, TIER_ORDER.indexOf(tool) <= TIER_ORDER.indexOf(max)])
  it.each(cases)('tool %s with maxTier %s -> allowed=%s', async (tier, max, allowed) => {
    const f = fixture()
    const reg = createRegistry(); reg.register(fake('x.tool', tier))
    const result = await execTool(ctxOf(f, reg, max), 'x.tool', { projectId: 'p1' })
    expect(result.ok).toBe(allowed)
    if (!allowed) expect(result.code).toBe('tier_denied')
    expect(audits(f)).toHaveLength(1)
    expect(audits(f)[0]).toMatchObject({ tool: 'x.tool', tier, ok: allowed, projectId: 'p1' })
    f.close()
  })
  it('consults the injected guard after tier, and skips the handler when denied', async () => {
    const f = fixture()
    let handled = 0
    const reg = createRegistry(); reg.register(fake('x.tool', 'R1', { handler: () => { handled++; return { ok: true } } }))
    const seen: unknown[] = []
    const guard: ControlGuard = { check: (req) => { seen.push(req); return { ok: false, code: 'budget_exceeded' } } }
    const denied = await execTool(ctxOf(f, reg, 'R1', guard), 'x.tool', { projectId: 'p1' })
    expect(denied).toMatchObject({ ok: false, code: 'budget_exceeded', tool: 'x.tool', projectId: 'p1' })
    expect(handled).toBe(0)
    expect(seen).toEqual([{ tool: 'x.tool', tier: 'R1', projectId: 'p1', input: { projectId: 'p1' } }])
    const above = await execTool(ctxOf(f, reg, 'R0', guard), 'x.tool', { projectId: 'p1' })
    expect(above.code).toBe('tier_denied')
    expect(seen).toHaveLength(1)
    f.close()
  })
  it('denies unknown tools and off flags, and maps handler throws to coded audited failures', async () => {
    const f = fixture()
    const reg = createRegistry()
    reg.register(fake('flagged.tool', 'R0', { flag: 'WEBTERM_TEST_FLAG' }))
    reg.register(fake('boom.tool', 'R0', { handler: () => { throw Object.assign(new Error('secret detail'), { code: 'boom_code' }) } }))
    reg.register(fake('plain.boom', 'R0', { handler: () => { throw new Error('secret detail') } }))
    expect((await execTool(ctxOf(f, reg, 'R3'), 'nope', {})).code).toBe('unknown_tool')
    expect((await execTool(ctxOf(f, reg, 'R3', ALLOW_ALL_GUARD, { env: {} }), 'flagged.tool', { projectId: 'p1' })).code).toBe('flag_off')
    expect((await execTool(ctxOf(f, reg, 'R3', ALLOW_ALL_GUARD, { env: { WEBTERM_TEST_FLAG: 'on' } }), 'flagged.tool', { projectId: 'p1' })).ok).toBe(true)
    expect((await execTool(ctxOf(f, reg, 'R3'), 'boom.tool', { projectId: 'p1' })).code).toBe('boom_code')
    expect((await execTool(ctxOf(f, reg, 'R3'), 'plain.boom', { projectId: 'p1' })).code).toBe('invalid_proposal')
    expect(audits(f)).toHaveLength(5)
    expect(JSON.stringify(audits(f))).not.toContain('secret detail')
    f.close()
  })
})

describe('execTool validation on core tools', () => {
  const goal = { projectId: 'p1', statement: 'Ship', successCriteria: [{ kind: 'review', by: 'human' }], owner: 'human:root', horizon: '2026-11-30', envelope: { maxCostMicros: 1, maxWallMs: 1, maxItems: 1 } }
  it('denies forbidden keys (I1/I3/I4), missing projects and bad shapes, then applies a valid goal', async () => {
    const f = fixture()
    const ctx = ctxOf(f, defaultRegistry(), 'R1')
    for (const key of ['actor', 'token', 'cwd', 'nonce', 'decision']) {
      expect((await execTool(ctx, 'goal.propose', { ...goal, envelope: { [key]: 'x' } })).code).toBe('forbidden_key')
    }
    const approval = { projectId: 'p1', requestId: 'r-1', kind: 'deploy', request: { target: 'staging' } }
    expect((await execTool(ctx, 'approval.request', { ...approval, request: { nonce: 'x' } })).code).toBe('forbidden_key')
    expect((await execTool(ctx, 'approval.request', { ...approval, digest: 'x' })).code).toBe('forbidden_key')
    expect((await execTool(ctx, 'goal.propose', { ...goal, projectId: '' })).code).toBe('project_required')
    expect((await execTool(ctx, 'goal.propose', { ...goal, projectId: 'nope' })).code).toBe('project_not_found')
    expect((await execTool(ctxOf(f, defaultRegistry(), 'R1', ALLOW_ALL_GUARD, { conversationId: 'central:project:p2' }), 'goal.propose', goal)).code).toBe('conversation_project_mismatch')
    expect((await execTool(ctx, 'plan.propose', { projectId: 'p1', items: [{ title: 1 }] })).code).toBe('invalid_shape')
    expect(await execTool(ctx, 'goal.propose', goal)).toMatchObject({ ok: true, data: { goalVersion: 1 } })
    expect(audits(f).at(-1)).toMatchObject({ tool: 'goal.propose', ok: true, goalVersion: 1, tier: 'R1' })
    expect(audits(f)).toHaveLength(12)
    f.close()
  })
  it('core tools are denied below R1', async () => {
    const f = fixture()
    expect((await execTool(ctxOf(f, defaultRegistry(), 'R0'), 'goal.propose', goal)).code).toBe('tier_denied')
    f.close()
  })
})
