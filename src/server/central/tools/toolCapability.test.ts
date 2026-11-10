import { describe, expect, it } from 'vitest'
import { obj, S } from '../../capability/capability.schema'
import { createMemoryReceiptLog } from '../../capability/capability.receipt'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { CAP_DEFS } from './defs/cap.defs'
import { CORE_DEFS } from './defs/core.defs'
import { ALLOW_ALL_GUARD, execTool, execToolReceipt } from './toolExec'
import { toolCapability, toolInputSchema } from './toolCapability'
import { createRegistry } from './toolRegistry'
import type { Tier, ToolCtx, ToolDef, ToolRegistry } from './toolTypes'

const ENV = { WEBTERM_CENTRAL_READ_TOOLS: 'on' } // test-only
function def(name: string, extra: Partial<ToolDef> = {}): ToolDef {
  return { name, summary: `fake ${name}`, tier: 'R0', usage: `{"projectId":"<id>"} ${'x'.repeat(40)}`, input: obj({ n: S.int(1, 3) }), output: S.keys('n'), validate: () => null, handler: () => ({ ok: true, data: { n: 1 } }), ...extra }
}
function registryOf(defs: readonly ToolDef[]): ToolRegistry { const r = createRegistry(); defs.forEach((d) => r.register(d)); return r }
function fixture(): Fixture { const f = openFixture(); seedPortfolio(f.db); return f }
const ctxOf = (f: Fixture, registry: ToolRegistry, maxTier: Tier = 'R3'): ToolCtx => ({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'global', now: () => 1_700_000_000_000, env: ENV })

describe('ToolDef as capability', () => {
  it('adds a required projectId to project-scoped inputs and maps scope', () => {
    const scoped = def('a.one')
    expect(toolInputSchema(scoped)?.required).toEqual(['projectId'])
    expect(toolCapability(scoped)).toMatchObject({ scope: 'project', projections: ['central'], tier: 'R0' })
    expect(toolCapability(def('a.two', { projectScoped: false })).scope).toBe('global')
    expect(toolInputSchema(def('a.two', { projectScoped: false }))?.properties).not.toHaveProperty('projectId')
  })
  it('register rejects a malformed declared schema', () => {
    expect(() => registryOf([def('a.one', { input: S.str() })])).toThrow(/invalid capability declaration: input/)
    expect(() => registryOf([def('a.one', { output: undefined })])).toThrow(/output/)
  })
  it('the declared schema is enforced before validate', async () => {
    const f = fixture()
    let validated = 0
    const reg = registryOf([def('a.one', { validate: () => { validated++; return null } })])
    expect(await execTool(ctxOf(f, reg), 'a.one', { projectId: 'p1', n: 9 })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(validated).toBe(0)
    expect(await execTool(ctxOf(f, reg), 'a.one', { projectId: 'p1', n: 2 })).toMatchObject({ ok: true })
    f.close()
  })
})

describe('cap.search / cap.describe', () => {
  const reg = registryOf([...CORE_DEFS, ...CAP_DEFS, def('flagged.tool', { flag: 'WEBTERM_TEST_OFF' })])
  it('search finds enabled tools of any tier and hides tools whose flag is off', async () => {
    const f = fixture()
    const found = await execTool(ctxOf(f, reg, 'R0'), 'cap.search', { query: 'plan' })
    expect(found).toMatchObject({ ok: true })
    expect((found.data?.tools as Array<{ name: string; tier: string }>).map((t) => t.name)).toEqual(expect.arrayContaining(['plan.propose']))
    expect((await execTool(ctxOf(f, reg, 'R0'), 'cap.search', { query: 'flagged' })).data).toMatchObject({ count: 0 })
    expect((await execTool(ctxOf(f, reg, 'R0'), 'cap.search', {})).code).toBe('invalid_shape')
    f.close()
  })
  it('describe returns the full schema (with projectId) and usage, not_found otherwise', async () => {
    const f = fixture()
    const res = await execTool(ctxOf(f, reg, 'R0'), 'cap.describe', { name: 'plan.propose' })
    expect(res.data).toMatchObject({ name: 'plan.propose', tier: 'R1', scope: 'project', input: { required: ['projectId', 'items'] } })
    expect(String(res.data?.usage)).toContain('blockedBy')
    expect((await execTool(ctxOf(f, reg, 'R0'), 'cap.describe', { name: 'flagged.tool' })).code).toBe('not_found')
    f.close()
  })
})

describe('execToolReceipt', () => {
  it('maps outcomes to receipts with audit evidence and a next hint', async () => {
    const f = fixture()
    const reg = registryOf([def('a.one'), def('a.hi', { tier: 'R2' })])
    const { receipt, result } = await execToolReceipt(ctxOf(f, reg), 'a.one', { projectId: 'p1', n: 1 })
    expect(result).toMatchObject({ ok: true, data: { n: 1 } })
    expect(receipt).toMatchObject({ outcome: 'ok', detail: 'ok', next: null, operationId: null, evidence: { tool: 'a.one', projectId: 'p1', dataKeys: ['n'] } })
    expect(typeof receipt.evidence.auditSeq).toBe('number')
    expect((await execToolReceipt(ctxOf(f, reg, 'R0'), 'a.hi', { projectId: 'p1' })).receipt).toMatchObject({ outcome: 'denied', detail: 'tier_denied' })
    expect((await execToolReceipt(ctxOf(f, reg), 'nope', {})).receipt).toMatchObject({ outcome: 'error', detail: 'unknown_tool', next: expect.stringContaining('cap.search') })
    f.close()
  })
  it('replays by operationId without running the handler twice', async () => {
    const f = fixture()
    let runs = 0
    const reg = registryOf([def('a.one', { handler: () => { runs++; return { ok: true, data: { n: runs } } } })])
    const log = createMemoryReceiptLog()
    const first = await execToolReceipt(ctxOf(f, reg), 'a.one', { projectId: 'p1' }, { operationId: 'op-1', log })
    const again = await execToolReceipt(ctxOf(f, reg), 'a.one', { projectId: 'p1' }, { operationId: 'op-1', log })
    expect(runs).toBe(1)
    expect(again.receipt).toMatchObject({ outcome: 'ok', replayed: true, evidence: first.receipt.evidence })
    expect(again.result).toBeUndefined()
    expect((await execToolReceipt(ctxOf(f, reg), 'a.one', { projectId: 'p1', n: 2 }, { operationId: 'op-1', log })).receipt.detail).toBe('operation_conflict')
    f.close()
  })
})
