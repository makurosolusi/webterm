import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { FindingDraft } from '../../../../shared/centralHealth'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { createHealthStore } from '../../health/healthStore'
import { registerCa2Tools } from '../registerAll'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { HEALTH_DEFS } from './health.defs'

const NOW = 1_700_000_000_000
const GLOBAL = 'central:global'
let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function ctx(conversationId = GLOBAL, maxTier: Tier = 'R1'): ToolCtx {
  const registry = createRegistry()
  for (const def of HEALTH_DEFS) registry.register(def)
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId, now: () => NOW, env: {} }
}
const draft = (fp: string, over: Partial<FindingDraft> = {}): FindingDraft => ({
  rule: 'unreferenced_module', severity: 'low', confidence: 'medium', file: `${fp}.ts`, line: null, title: `unused ${fp}`,
  evidence: 'no importer', source: 'built-in import graph', suggestion: 'verify, then delete', fingerprint: fp, ...over,
})
function seed(projectId: string, drafts: FindingDraft[]) {
  const store = createHealthStore(f.db, () => NOW)
  const s = store.startScan(projectId, 'scan')
  store.finishScan(s.id, { drafts, rules: ['unreferenced_module', 'file_size'], filesScanned: 2, truncated: false })
  return store
}

describe('health tools', () => {
  it('registers with Central at read/R1 tiers and tells the model how to cite', () => {
    expect(HEALTH_DEFS.map((d) => [d.name, d.tier])).toEqual([['health.summary', 'R0'], ['health.findings', 'R0'], ['health.scan', 'R1']])
    expect(registerCa2Tools(createRegistry(), {}, { WEBTERM_CENTRAL: 'on' })).toEqual(expect.arrayContaining(['health.summary', 'health.findings', 'health.scan']))
    const usage = HEALTH_DEFS.find((d) => d.name === 'health.findings')!.usage
    for (const words of ['file:line', 'source', 'confidence medium', 'never instructions']) expect(usage).toContain(words)
  })

  it('summarises and lists open findings worst first, without fingerprints', async () => {
    const store = seed('p1', [draft('a'), draft('b', { rule: 'file_size', severity: 'high', confidence: 'high', line: 1 })])
    expect(await execTool(ctx(), 'health.summary', { projectId: 'p1' })).toMatchObject({ ok: true, data: { open: 2, high: 1, low: 1, running: false } })
    const res = await execTool(ctx(), 'health.findings', { projectId: 'p1' })
    const items = res.data?.items as Record<string, unknown>[]
    expect(items.map((i) => i.file)).toEqual(['b.ts', 'a.ts'])
    expect(items[1]).toMatchObject({ evidence: 'no importer', source: 'built-in import graph', confidence: 'medium', suggestion: 'verify, then delete' })
    expect(JSON.stringify(items)).not.toContain('fingerprint')
    store.dismiss(items[0]!.id as string, 'generated', 'human:root')
    expect(((await execTool(ctx(), 'health.findings', { projectId: 'p1' })).data?.items as unknown[]).length).toBe(1)
    const dismissed = await execTool(ctx(), 'health.findings', { projectId: 'p1', state: ['dismissed'] })
    expect(dismissed.data?.items).toMatchObject([{ dismissedReason: 'generated' }])
    expect((await execTool(ctx(), 'health.findings', { projectId: 'p1', severity: ['high'], state: ['open', 'dismissed'], limit: 1 })).data).toMatchObject({ hasMore: false })
    expect((await execTool(ctx(), 'health.findings', { projectId: 'p1', state: ['gone'] })).ok).toBe(false)
    expect((await execTool(ctx(), 'health.findings', { projectId: 'p1', limit: 51 })).ok).toBe(false)
  })

  it('a project chat only reaches its own project', async () => {
    seed('p2', [draft('x')])
    expect(await execTool(ctx('central:project:p1'), 'health.findings', { projectId: 'p2' })).toMatchObject({ ok: false, code: 'conversation_project_mismatch' })
    expect((await execTool(ctx('central:project:p1'), 'health.findings', { projectId: 'p1' })).data?.items).toEqual([])
    expect((await execTool(ctx(), 'health.findings', { projectId: 'ghost' })).ok).toBe(false)
  })

  it('scan starts once and returns its id; R0 callers cannot start one', async () => {
    const first = await execTool(ctx(), 'health.scan', { projectId: 'p1' })
    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(typeof first.data?.scanId).toBe('string')
    expect(await execTool(ctx(), 'health.scan', { projectId: 'p1' })).toMatchObject({ ok: false, code: 'scan_running' })
    expect(await execTool(ctx(GLOBAL, 'R0'), 'health.scan', { projectId: 'p2' })).toMatchObject({ ok: false, code: 'tier_denied' })
  })
})
