import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { allRows } from '../../ledger/ledgerCore'
import type { AgentRecord, ControlGuard, GuardDecision, GuardRequest, GuardUsage } from '../contracts'
import { openFixture, seedPortfolio } from '../centralTestFixture.testutil'
import { AGENT_ENVELOPE, type AgentHost, agentNodeId, createAgentExecutor, type SpawnInput } from './agentExecutor'
import { agentReqId } from './agentStore'
import { createAgentSpawner } from '../../spawn/agentSpawn'
import { SERVER_VERIFIED_BY } from '../../orchestrator/orchestratorModel'
import { judgeCompletion } from '../../verifier/verifier.judge'
import type { VerifyAgentCompletion } from './agentVerify'

const T0 = 1_700_000_000_000
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Polls until `ok()` (child exit + async verify take longer than a fixed sleep on a loaded machine). */
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await wait(25)
}
const SETTLED = ['accepted', 'rejected', 'failed']

function fakeGuard(decide: (req: GuardRequest) => GuardDecision = () => ({ verdict: 'allow', level: 'act_gated' })) {
  const calls: GuardRequest[] = []
  const usage: GuardUsage[] = []
  const guard: ControlGuard = {
    check: (req) => { calls.push(req); return decide(req) }, effectiveLevel: () => 'act_gated', recordUsage: (u) => { usage.push(u) },
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  return { guard, calls, usage }
}
function fakeHost(over: Partial<AgentHost> = {}) {
  const sessions = new Set<string>()
  const sent: Array<[string, string]> = []
  const closed: Array<[string, boolean]> = []
  let opens = 0
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'do it',
    openPty: async (_a, _cwd, nodeId) => { opens++; await Promise.resolve(); sessions.add(nodeId) },
    headlessArgv: () => null, send: async (n, t) => { sent.push([n, t]); return { ok: true as const, started: true as const } }, scrollback: async () => ['l1', 'l2', 'l3'],
    closePty: async (n, f) => { closed.push([n, f]); sessions.delete(n) }, hasSession: (n) => sessions.has(n), ...over,
  }
  return { host, sessions, sent, closed, opens: () => opens }
}
/** Fake completion verifier (test-only): the verdict a real diff/test run would produce. */
function fakeVerdict(changedFiles: string[]): VerifyAgentCompletion {
  return async (agent) => judgeCompletion({
    taskId: agent.taskId ?? agent.id,
    verdict: { verifiedBy: SERVER_VERIFIED_BY, ok: true, reasons: [], evidence: [{ command: 'npm test', exitCode: 0, durationMs: 1, outputDigest: 'd'.repeat(64), summary: 'exit 0' }], changedFiles, scopeViolations: [], tests: { passed: 2, failed: 0, command: 'npm test' } },
  })
}
function setup(decide?: (req: GuardRequest) => GuardDecision, hostOver: Partial<AgentHost> = {}, verifyCompletion: VerifyAgentCompletion = fakeVerdict(['src/a.ts'])) {
  const f = openFixture(); seedPortfolio(f.db)
  const g = fakeGuard(decide)
  const h = fakeHost(hostOver)
  const ex = createAgentExecutor({ db: f.db, guard: g.guard, host: h.host, now: () => T0, verifyCompletion })
  const input = (over: Partial<SpawnInput> = {}): SpawnInput => ({ projectId: 'p1', kind: 'opencode', role: 'worker', title: 't', reqId: agentReqId('p1', 'r1'), owner: 'central:c1', requireApproval: false, ...over })
  const events = () => allRows(f.db, "SELECT payload_json FROM event WHERE kind = 'central.agent' ORDER BY seq").map((r) => (JSON.parse(String(r.payload_json)) as { phase: string }).phase)
  return { f, g, h, ex, input, events }
}

describe('spawn', () => {
  it('guards, launches, records intent then done, and counts one spawn in the budget', async () => {
    const { g, h, ex, input, events } = setup()
    const res = await ex.spawn(input())
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ state: 'working', nodeId: agentNodeId(String(res.data?.agentId)), owner: 'central:c1' })
    expect(g.calls[0]).toMatchObject({ action: 'spawn', tool: 'agent.spawn', tier: 'R2', projectId: 'p1' })
    expect(g.usage).toHaveLength(1)
    expect(g.usage[0]).toMatchObject({ spawns: 1, projectId: 'p1' })
    expect(h.sessions.size).toBe(1)
    expect(events()).toEqual(['spawn.requested', 'spawn.intent', 'spawn.done'])
  })
  it('is idempotent: same req_id, sequential or concurrent, spawns exactly once', async () => {
    const { h, ex, input, g } = setup()
    const [a, b] = await Promise.all([ex.spawn(input()), ex.spawn(input())])
    const c = await ex.spawn(input())
    expect(a.data?.agentId).toBe(b.data?.agentId)
    expect(c.data).toMatchObject({ agentId: a.data?.agentId, reused: true })
    expect(h.opens()).toBe(1)
    expect(g.usage).toHaveLength(1)
    expect(ex.store.countActive('p1')).toBe(1)
  })
  it('rejects the same req_id with different parameters', async () => {
    const { ex, input } = setup()
    await ex.spawn(input())
    expect((await ex.spawn(input({ kind: 'codex' }))).code).toBe('request_conflict')
  })
  it('returns the guard denial code and leaves no row and no session', async () => {
    const { h, ex, input } = setup(() => ({ verdict: 'deny', level: 'act_gated', code: 'spawn_daily', reason: 'cap' }))
    const res = await ex.spawn(input())
    expect(res).toEqual({ ok: false, code: 'spawn_daily' })
    expect(ex.store.listActive()).toEqual([])
    expect(h.opens()).toBe(0)
  })
  it('needs_approval parks the agent in approval_pending with a card; resume launches it once', async () => {
    const { h, ex, input, f } = setup(() => ({ verdict: 'needs_approval', level: 'propose', tier: 'R2' }))
    const res = await ex.spawn(input())
    expect(res.code).toBe('approval_required')
    const id = String(res.data?.agentId)
    expect(ex.store.get(id)?.state).toBe('approval_pending')
    expect(allRows(f.db, 'SELECT kind, status FROM approval WHERE id = ?', `agent-${id}`)).toEqual([{ kind: 'agent.spawn', status: 'pending' }])
    expect(h.opens()).toBe(0)
    expect((await ex.spawn(input())).code).toBe('approval_required')
    expect(allRows(f.db, 'SELECT id FROM approval WHERE kind = ?', 'agent.spawn').length).toBe(1)
    expect((await ex.resume(id)).data).toMatchObject({ state: 'working' })
    expect((await ex.resume(id)).code).toBe('not_pending')
    expect(h.opens()).toBe(1)
  })
  it('requireApproval (propose mode) turns an allowed spawn into a card', async () => {
    const { ex, input, h } = setup()
    expect((await ex.spawn(input({ requireApproval: true }))).code).toBe('approval_required')
    expect(h.opens()).toBe(0)
  })
  it('a launch failure ends in failed with a stage reason and no message leak', async () => {
    const { ex, input } = setup(undefined, { openPty: async () => { throw new Error('/secret/path boom') } })
    const res = await ex.spawn(input())
    expect(res).toMatchObject({ ok: false, code: 'spawn_failed', data: { stage: 'runner' } })
    expect(JSON.stringify(res)).not.toContain('/secret')
    expect(ex.store.get(String(res.data?.agentId))).toMatchObject({ state: 'failed', endReason: 'spawn_failed:runner' })
  })
})

describe('crash between intent and done', () => {
  const crashed = async (opts: { sessionExists: boolean; state: 'provisioning' | 'starting' }) => {
    const s = setup()
    const a = s.ex.store.create({ id: 'ag-x', projectId: 'p1', kind: 'opencode', role: 'worker', runner: 'pty', owner: 'central:c1', reqId: 'rq' })
    s.ex.store.transition(a.id, 'provisioning')
    if (opts.state === 'starting') s.ex.store.transition(a.id, 'starting')
    if (opts.sessionExists) s.h.sessions.add(agentNodeId(a.id))
    return { ...s, report: await s.ex.reconcile() }
  }
  it('adopts the already-running session instead of spawning a second one', async () => {
    for (const state of ['provisioning', 'starting'] as const) {
      const { ex, h, report, events } = await crashed({ sessionExists: true, state })
      expect(report).toMatchObject({ adopted: 1, failed: 0 })
      expect(ex.store.get('ag-x')).toMatchObject({ state: 'working', nodeId: 'c-ag-x' })
      expect(h.opens()).toBe(0)
      expect(events()).toContain('spawn.done')
    }
  })
  it('closes the intent as failed when no session exists, and the retry gets the same row', async () => {
    const { ex, report, h } = await crashed({ sessionExists: false, state: 'provisioning' })
    expect(report).toMatchObject({ adopted: 0, failed: 1 })
    expect(ex.store.get('ag-x')).toMatchObject({ state: 'failed', endReason: 'spawn_interrupted' })
    const retry = await ex.spawn({ projectId: 'p1', kind: 'opencode', role: 'worker', title: 't', reqId: 'rq', owner: 'central:c1', requireApproval: false })
    expect(retry.data).toMatchObject({ agentId: 'ag-x', reused: true })
    expect(h.opens()).toBe(0)
  })
  it('orphans active agents whose session vanished and finishes a half-done close', async () => {
    const s = setup()
    const w = (await s.ex.spawn(s.input())).data as { agentId: string }
    s.h.sessions.clear()
    const closing = s.ex.store.create({ id: 'cl', projectId: 'p1', kind: 'k', role: 'worker', runner: 'pty', owner: 'human', reqId: 'rc' })
    for (const to of ['provisioning', 'starting', 'working', 'candidate_done', 'verifying', 'accepted', 'closing'] as const) s.ex.store.transition(closing.id, to, to === 'working' ? { nodeId: 'c-cl' } : {})
    expect(await s.ex.reconcile()).toMatchObject({ orphaned: 1, closed: 1 })
    expect(s.ex.store.get(w.agentId)?.state).toBe('orphaned')
    expect(s.ex.store.get('cl')?.state).toBe('closed')
    expect(s.ex.store.listActive()).toEqual([])
  })
})

describe('prompt / close / read', () => {
  const spawned = async () => { const s = setup(); const r = await s.ex.spawn(s.input()); return { ...s, agent: s.ex.store.get(String(r.data?.agentId)) as AgentRecord } }
  it('F4-c: the handoff prompt is masked of secrets before it reaches the worker', async () => {
    const { h, ex, input } = setup()
    const agent = ex.store.get(String((await ex.spawn(input())).data?.agentId)) as AgentRecord
    await ex.prompt(agent, 'deploy with sk-abcdefghijklmnopqrstuvwxyz0123', 'steer')
    expect(h.sent[0]?.[1]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(h.sent[0]?.[1]).toContain('[redacted]')
  })
  it('wraps the text in the not-human envelope and strips terminal control bytes', async () => {
    const { ex, agent, h } = await spawned()
    const res = await ex.prompt(agent, 'hello\x1b[2J\x07 world', 'steer')
    expect(res.ok).toBe(true)
    expect(h.sent[0]).toEqual([agent.nodeId, `${AGENT_ENVELOPE}\nhello[2J world`])
  })
  it('followup is refused while working; allowed once waiting_input, moving the agent back to working', async () => {
    const { ex, agent, h } = await spawned()
    expect((await ex.prompt(agent, 'x', 'followup')).code).toBe('agent_busy')
    const waiting = ex.store.transition(agent.id, 'waiting_input')
    expect((await ex.prompt(waiting, 'x', 'followup')).data).toMatchObject({ state: 'working' })
    expect(h.sent).toHaveLength(1)
  })
  it('refuses prompts to non-active, exec or session-less agents', async () => {
    const { ex, agent, h } = await spawned()
    h.sessions.clear()
    expect((await ex.prompt(agent, 'x', 'steer')).code).toBe('session_gone')
    expect((await ex.prompt({ ...agent, runner: 'exec' }, 'x', 'steer')).code).toBe('prompt_unsupported')
    expect((await ex.prompt({ ...agent, state: 'verifying' }, 'x', 'steer')).code).toBe('agent_not_active')
  })
  it('close cancels gracefully or kills with force, closes the session, and is idempotent', async () => {
    const a = await spawned()
    expect((await a.ex.close(a.agent, 'done', false)).data).toMatchObject({ state: 'cancelled', endReason: 'done' })
    expect(a.h.closed).toEqual([[a.agent.nodeId, false]])
    expect((await a.ex.close(a.ex.store.get(a.agent.id) as AgentRecord, 'again', true)).data).toMatchObject({ already: true, state: 'cancelled' })
    const b = await spawned()
    expect((await b.ex.close(b.agent, 'stuck', true)).data).toMatchObject({ state: 'killed' })
    expect(b.h.closed).toEqual([[b.agent.nodeId, true]])
  })
  it('close of an accepted agent goes closing -> closed', async () => {
    const s = await spawned()
    for (const to of ['candidate_done', 'verifying', 'accepted'] as const) s.ex.store.transition(s.agent.id, to)
    expect((await s.ex.close(s.ex.store.get(s.agent.id) as AgentRecord, 'merged', false)).data).toMatchObject({ state: 'closed' })
  })
  it('read returns at most `tail` lines', async () => {
    const { ex, agent } = await spawned()
    expect((await ex.read(agent, 2)).data).toEqual({ agentId: agent.id, lines: ['l2', 'l3'] })
  })
})

describe('exec runner agents', { timeout: 20_000 }, () => {
  const headless = (script: string) => ({ worktree: async () => tmpdir(), runnerFor: () => 'exec' as const, headlessArgv: () => [process.execPath, '-e', script] as const })
  it('runs headless, exit 0 goes through the verifier to accepted, failed otherwise, and exposes the tail', async () => {
    const ok = setup(undefined, headless('console.log(JSON.stringify({done:true}))'))
    const res = await ok.ex.spawn(ok.input())
    const id = String(res.data?.agentId)
    expect(res.data).toMatchObject({ state: 'working', runner: 'exec', nodeId: null })
    await until(() => SETTLED.includes(ok.ex.store.get(id)?.state ?? ''))
    expect(ok.ex.store.get(id)).toMatchObject({ state: 'accepted', endReason: 'verified' })
    expect(ok.events()).toEqual(expect.arrayContaining(['exec.exit', 'verify']))
    const inbox = allRows(ok.f.db, "SELECT kind, title FROM inbox_item WHERE source = 'verifier'")
    expect(inbox).toEqual([{ kind: 'review', title: `${id} finished: 1 file, tests green ✓` }])
    expect(JSON.stringify((await ok.ex.read(ok.ex.store.get(id) as AgentRecord, 5)).data)).toContain('done')
    const bad = setup(undefined, headless('process.exit(2)'))
    const id2 = String((await bad.ex.spawn(bad.input())).data?.agentId)
    await until(() => SETTLED.includes(bad.ex.store.get(id2)?.state ?? ''))
    expect(bad.ex.store.get(id2)).toMatchObject({ state: 'failed', endReason: 'exec_exit_2' })
  })
  it('a kind without a headless form fails the spawn instead of hanging', async () => {
    const s = setup(undefined, { runnerFor: () => 'exec', headlessArgv: () => null })
    expect((await s.ex.spawn(s.input())).code).toBe('spawn_failed')
  })
  it('close kills the process and the late exit does not overwrite the state', async () => {
    const s = setup(undefined, headless('setInterval(()=>{},1000)'))
    const agent = s.ex.store.get(String((await s.ex.spawn(s.input())).data?.agentId)) as AgentRecord
    expect((await s.ex.close(agent, 'stop', false)).data).toMatchObject({ state: 'cancelled' })
    await wait(300)
    expect(s.ex.store.get(agent.id)?.state).toBe('cancelled')
  })
  it('headless runs go through agent.spawn: lineage under central, agent.spawn then agent.exit', async () => {
    const s = setup(undefined, headless('process.exit(0)'))
    const lineage: [string, string][] = []
    const kinds: string[] = []
    const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: (p, c) => { lineage.push([p, c]) }, record: (e) => { kinds.push(`${e.kind}:${(e.payload as { door?: string }).door ?? ''}`) }, onPtyExit: () => {} })
    const ex = createAgentExecutor({ db: s.f.db, guard: s.g.guard, host: s.h.host, now: () => T0, spawn: spawner.spawn, verifyCompletion: fakeVerdict(['src/a.ts']) })
    const id = String((await ex.spawn(s.input())).data?.agentId)
    await until(() => SETTLED.includes(ex.store.get(id)?.state ?? ''))
    expect(lineage).toEqual([['central', `node:${agentNodeId(id)}`]])
    expect(kinds).toEqual(['agent.spawn:central', 'agent.exit:'])
    expect(ex.store.get(id)?.state).toBe('accepted')
  })
  it('F4-c: exit 0 without a diff is rejected (no changes); the worker claim never accepts it', async () => {
    const s = setup(undefined, headless('console.log("all done, every test passed")'), fakeVerdict([]))
    const id = String((await s.ex.spawn(s.input())).data?.agentId)
    await until(() => SETTLED.includes(s.ex.store.get(id)?.state ?? ''))
    expect(s.ex.store.get(id)?.state).toBe('rejected')
    expect(allRows(s.f.db, "SELECT kind, title FROM inbox_item WHERE source = 'verifier'")).toEqual([{ kind: 'notify', title: `${id} failed verification: no changes` }])
  })
  it('F4-c: a verifier crash ends failed, not accepted', async () => {
    const s = setup(undefined, headless('process.exit(0)'), async () => { throw new Error('tool missing') })
    const id = String((await s.ex.spawn(s.input())).data?.agentId)
    await until(() => SETTLED.includes(s.ex.store.get(id)?.state ?? ''))
    expect(s.ex.store.get(id)).toMatchObject({ state: 'failed', endReason: 'verifier_error' })
  })
})
