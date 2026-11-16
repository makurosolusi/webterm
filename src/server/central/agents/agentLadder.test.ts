// Root lock: every Central worker launch (PTY, headless) runs through the model ladder, and the PTY line carries it.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ControlGuard } from '../contracts'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import { defaultTier, TIER_TABLE } from '../../models/modelLadder'
import { registerModelSettings } from '../../models/modelOverride'
import { createAgentSpawner } from '../../spawn/agentSpawn'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import type { AgentCatalog, CatalogEntry } from './agentCatalog'
import { createAgentExecutor, type SpawnInput } from './agentExecutor'
import { createAgentHost } from './agentHost'
import { agentReqId } from './agentStore'
import { COMPLEXITIES } from './agentLadder'

const T0 = 1_700_000_000_000
const MODEL_ENV = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']
const saved: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of MODEL_ENV) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { registerModelSettings(() => ({})); for (const k of MODEL_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

/** Executor over the REAL host and spawner; only sessions, worktrees and the catalog line are fake (test-only). */
function rig(launchLine = 'claude --dangerously-skip-permissions') {
  const f = openFixture(); seedPortfolio(f.db)
  const opened: { cmd?: string; resume?: boolean }[] = []
  const live = new Set<string>()
  const sessions = {
    open: (i: { nodeId: string; cmd?: string; resume?: boolean }) => { opened.push(i); live.add(i.nodeId) },
    submit: async () => ({ ok: true as const, started: true as const }), isLive: (n: string) => live.has(n), getTerminal: () => '', close: () => undefined,
  } as unknown as WorkerSessionPort
  const entry = { kind: 'claude', builtin: true, launchLine, headlessArgv: null, tier: 'R2', childEnv: () => ({}) } as unknown as CatalogEntry
  const catalog: AgentCatalog = { resolve: (k) => (k === 'claude' ? entry : null), kinds: () => [] }
  const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: () => undefined, record: () => undefined, onPtyExit: () => undefined })
  const host = createAgentHost({ sessions, worktrees: { get: () => ({ path: '/wt' }), allocate: async () => ({ path: '/wt' }) } as unknown as WorktreeService, repoOf: () => null, catalog, spawn: spawner.spawn })
  const guard: ControlGuard = {
    check: () => ({ verdict: 'allow', level: 'act_gated' }), effectiveLevel: () => 'act_gated', recordUsage: () => undefined,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  const ex = createAgentExecutor({ db: f.db, guard, host, now: () => T0 })
  let n = 0
  const input = (over: Partial<SpawnInput> = {}): SpawnInput => ({ projectId: 'p1', kind: 'claude', role: 'worker', title: 't', reqId: agentReqId('p1', `r${++n}`), owner: 'central:c1', requireApproval: false, ...over })
  return { f, ex, host, opened, input }
}

describe('PTY workers follow the ladder', () => {
  it('default: sonnet/medium on the command line, never the CLI default; the result names tier and model', async () => {
    const { ex, opened, input } = rig()
    const res = await ex.spawn(input())
    expect(opened[0]?.cmd).toMatch(/^claude --dangerously-skip-permissions --model sonnet --effort medium /)
    expect(res.data).toMatchObject({ tier: 'T2', model: 'sonnet', effort: 'medium' })
  })

  it.each([['simple', 'haiku', 'low', 'T1'], ['moderate', 'sonnet', 'medium', 'T2'], ['complex', 'opus', 'high', 'T3']] as const)('complexity %s -> %s/%s', async (complexity, model, effort, tier) => {
    const { ex, opened, input } = rig()
    const res = await ex.spawn(input({ complexity }))
    expect(opened[0]?.cmd).toContain(`--model ${model} --effort ${effort}`)
    expect(res.data).toMatchObject({ tier, model, effort })
  })

  it('no complexity value reaches Fable or T4', () => {
    for (const c of COMPLEXITIES) expect(TIER_TABLE[defaultTier('agent-spawn', c)].model).not.toBe('fable')
  })

  it('a --model already on the launch profile wins over the ladder', async () => {
    const { ex, opened, input } = rig('claude --model haiku')
    await ex.spawn(input({ complexity: 'complex' }))
    expect(opened[0]?.cmd).not.toContain('--model sonnet')
    expect(opened[0]?.cmd).not.toContain('--model opus')
    expect(opened[0]?.cmd).toContain('--model haiku')
    expect(opened[0]?.cmd).toContain('--effort high') // effort the profile did not set still follows the ladder
  })

  it('a per-project override wins; Fable without a grant runs on Opus', async () => {
    const a = rig()
    registerModelSettings(() => ({ projectModels: { p1: { model: 'haiku', effort: 'low' } } }))
    await a.ex.spawn(a.input({ complexity: 'complex' }))
    expect(a.opened[0]?.cmd).toContain('--model haiku --effort low')
    const b = rig()
    registerModelSettings(() => ({ projectModels: { p1: { model: 'fable' } } }))
    await b.ex.spawn(b.input())
    expect(b.opened[0]?.cmd).toContain('--model opus')
    expect(b.opened[0]?.cmd).not.toContain('fable')
  })

  it('a non-claude launch line is left exactly as defined', async () => {
    const { ex, opened, input } = rig('opencode')
    await ex.spawn(input())
    expect(opened[0]?.cmd?.startsWith('opencode')).toBe(true)
    expect(opened[0]?.cmd).not.toContain('--model')
  })

  it('resume relaunches on the model of the first spawn, even when the ladder would now decide otherwise', async () => {
    const { ex, host, opened, input } = rig()
    const res = await ex.spawn(input({ complexity: 'simple' }))
    const agent = ex.store.get(String(res.data?.agentId))!
    registerModelSettings(() => ({ projectModels: { p1: { model: 'opus' } } }))
    await host.resumePty!(agent, '/wt', 'n1', 60_000)
    expect(opened[1]?.resume).toBe(true)
    expect(opened[1]?.cmd).toContain('--model haiku --effort low')
    expect(opened[1]?.cmd).not.toContain('opus')
  })

  it('a verify failure of an earlier agent on the task climbs the next one a rung, at most two, never above T3', async () => {
    const { ex, opened, input } = rig()
    const fail = async (taskId: string) => {
      const r = await ex.spawn(input({ taskId }))
      const id = String(r.data?.agentId)
      ex.store.transition(id, 'candidate_done'); ex.store.transition(id, 'verifying'); ex.store.transition(id, 'rejected', { reason: 'verify_failed' })
      return r
    }
    expect((await fail('t1')).data).toMatchObject({ tier: 'T2' })
    expect((await fail('t1')).data).toMatchObject({ tier: 'T3', model: 'opus' })
    const third = await ex.spawn(input({ taskId: 't1' }))
    expect(third.data).toMatchObject({ tier: 'T3' })
    expect(opened[2]?.cmd).toContain('--model opus')
  })
})

describe('policy: every Central worker launch decides its model through the ladder', () => {
  const ROOT = join(__dirname, '..', '..')
  const isSource = (n: string): boolean => n.endsWith('.ts') && !/\.test\.ts$|\.testutil\.ts$/.test(n)
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : isSource(e.name) ? [join(dir, e.name)] : []))

  it('a source that spawns with door central carries a pick, and the one decision point is pickForAgent -> pickModel', () => {
    const doors = sources(ROOT).filter((f) => /door:\s*'central'/.test(readFileSync(f, 'utf8')))
    expect(doors.map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining(['central/agents/agentExecutor.ts', 'central/agents/agentHost.ts']))
    for (const f of doors) expect(readFileSync(f, 'utf8'), relative(ROOT, f)).toMatch(/\bpick\b/)
    expect(readFileSync(join(ROOT, 'central/agents/agentLadder.ts'), 'utf8')).toContain("kind: 'agent-spawn'")
    expect(readFileSync(join(ROOT, 'central/agents/agentExecutor.ts'), 'utf8')).toContain('pickForAgent(db, agent, now)')
  })
})
