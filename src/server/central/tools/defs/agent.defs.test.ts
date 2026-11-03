import { describe, expect, it } from 'vitest'
import { allRows } from '../../../ledger/ledgerCore'
import type { AgentRecord, ControlGuard, GuardDecision } from '../../contracts'
import { openFixture, seedPortfolio } from '../../centralTestFixture.testutil'
import { type AgentHost, createAgentExecutor } from '../../agents/agentExecutor'
import { createRegistry } from '../toolRegistry'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import type { Tier, ToolInput } from '../toolTypes'
import { AGENTS_FLAG, createAgentDefs } from './agent.defs'

const T0 = 1_700_000_000_000

function setup(decide: () => GuardDecision = () => ({ verdict: 'allow', level: 'act_gated' })) {
  const f = openFixture(); seedPortfolio(f.db)
  const sessions = new Set<string>()
  const sent: string[] = []
  const guard: ControlGuard = {
    check: () => decide(), effectiveLevel: () => 'act_gated', recordUsage: () => undefined,
    breaker: { allow: () => ({ allowed: true, state: 'closed' }), trip: () => 'closed', recordSuccess: () => undefined },
  }
  const host: AgentHost = {
    runnerFor: () => 'pty', spawnTier: () => 'R2', worktree: async (a) => `/tmp/wt/${a.id}`, initialPrompt: async () => 'go',
    openPty: async (_a, _cwd, nodeId) => { sessions.add(nodeId) }, headlessArgv: () => null,
    send: async (_n, t) => { sent.push(t) }, scrollback: async () => ['a', 'b', 'c'], closePty: async (n) => { sessions.delete(n) }, hasSession: (n) => sessions.has(n),
  }
  const executor = createAgentExecutor({ db: f.db, guard, host, now: () => T0 })
  const registry = createRegistry()
  createAgentDefs(executor).forEach((d) => registry.register(d))
  const run = (name: string, args: ToolInput, mode = 'auto', maxTier: Tier = 'R2') =>
    execTool({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'global', now: () => T0, env: { [AGENTS_FLAG]: mode } }, name, args)
  const spawn = (over: ToolInput = {}, mode = 'auto', maxTier: Tier = 'R2') => run('agent.spawn', { projectId: 'p1', requestId: 'r1', kind: 'opencode', role: 'worker', title: 'job', ...over }, mode, maxTier)
  const userAgent = (): AgentRecord => {
    const a = executor.store.create({ id: 'ag-user', projectId: 'p1', kind: 'k', role: 'worker', runner: 'pty', owner: 'human', reqId: 'ru' })
    for (const to of ['provisioning', 'starting'] as const) executor.store.transition(a.id, to)
    sessions.add('c-ag-user')
    return executor.store.transition(a.id, 'working', { nodeId: 'c-ag-user' })
  }
  return { f, executor, sessions, sent, run, spawn, userAgent }
}

describe('agent tools', () => {
  it('registers six tools with the planned tiers', () => {
    const { executor } = setup()
    expect(createAgentDefs(executor).map((d) => `${d.name}:${d.tier}`)).toEqual(['agent.list:R0', 'agent.status:R0', 'agent.read:R0', 'agent.spawn:R2', 'agent.prompt:R1', 'agent.close:R1'])
  })
  it('is inert unless the flag is propose or auto', async () => {
    const s = setup()
    for (const mode of ['', 'off', 'on', 'bogus']) expect((await s.spawn({}, mode)).code).toBe('flag_off')
    expect((await s.run('agent.list', { projectId: 'p1' }, '')).code).toBe('flag_off')
    expect(s.executor.store.list({ projectId: 'p1' })).toEqual([])
    expect(s.sessions.size).toBe(0)
  })
  it('spawn in auto mode is idempotent on requestId and the agent is listable, readable and visible in status', async () => {
    const s = setup()
    const a = await s.spawn()
    const b = await s.spawn()
    expect(a.ok).toBe(true)
    expect(b.data).toMatchObject({ agentId: a.data?.agentId, reused: true })
    expect(s.sessions.size).toBe(1)
    const id = String(a.data?.agentId)
    expect((await s.run('agent.list', { projectId: 'p1' })).data).toMatchObject({ count: 1 })
    expect((await s.run('agent.status', { projectId: 'p1', agentRef: id })).data).toMatchObject({ agentId: id, state: 'working', owner: 'central:global' })
    expect((await s.run('agent.read', { projectId: 'p1', agentRef: id, tail: 2 })).data).toEqual({ agentId: id, lines: ['b', 'c'] })
  })
  it('propose mode parks the spawn behind an approval card', async () => {
    const s = setup()
    const res = await s.spawn({}, 'propose')
    expect(res.code).toBe('approval_required')
    expect(s.sessions.size).toBe(0)
    expect(s.executor.store.get(String(res.data?.agentId))?.state).toBe('approval_pending')
  })
  it('spawn is R2: tier_denied at R1, and the guard denial code is passed through', async () => {
    expect((await setup().spawn({}, 'auto', 'R1')).code).toBe('tier_denied')
    const denied = setup(() => ({ verdict: 'deny', level: 'act_gated', code: 'spawn_daily', reason: 'cap' }))
    expect((await denied.spawn()).code).toBe('spawn_daily')
    expect(denied.sessions.size).toBe(0)
  })
  it('accepts role but still forbids cwd/token/command fields and unknown keys', async () => {
    const s = setup()
    for (const bad of [{ cwd: '/' }, { token: 'x' }, { command: 'rm' }, { env: { A: '1' } }, { extra: 1 }]) expect(['forbidden_key', 'invalid_shape']).toContain((await s.spawn(bad)).code)
    expect((await s.spawn({ role: 'worker' })).ok).toBe(true)
    expect((await setup().spawn({ role: 'admin' })).code).toBe('invalid_shape')
    expect((await setup().spawn({ requestId: 'has space' })).code).toBe('invalid_shape')
    expect((await setup().spawn({ taskId: 'nope' })).code).toBe('task_not_found')
  })
  it('central-owned agents are promptable and closable at R1', async () => {
    const s = setup()
    const id = String((await s.spawn()).data?.agentId)
    expect((await s.run('agent.prompt', { projectId: 'p1', agentRef: id, text: 'hi', mode: 'steer' }, 'auto', 'R1')).ok).toBe(true)
    expect(s.sent).toHaveLength(1)
    expect((await s.run('agent.close', { projectId: 'p1', agentRef: id, reason: 'done' }, 'auto', 'R1')).data).toMatchObject({ state: 'cancelled' })
  })
  it('user-owned agents need R2 for prompt/close and are untouched when denied', async () => {
    const s = setup()
    const a = s.userAgent()
    const prompt = { projectId: 'p1', agentRef: a.id, text: 'hi', mode: 'steer' }
    expect((await s.run('agent.prompt', prompt, 'auto', 'R1')).code).toBe('tier_denied')
    expect((await s.run('agent.close', { projectId: 'p1', agentRef: a.id, reason: 'x' }, 'auto', 'R1')).code).toBe('tier_denied')
    expect(s.sent).toEqual([])
    expect(s.executor.store.get(a.id)?.state).toBe('working')
    expect((await s.run('agent.prompt', prompt, 'auto', 'R2')).ok).toBe(true)
    const needs = setup(() => ({ verdict: 'needs_approval', level: 'propose', tier: 'R2' }))
    const b = needs.userAgent()
    expect((await needs.run('agent.close', { projectId: 'p1', agentRef: b.id, reason: 'x' }, 'auto', 'R2')).code).toBe('approval_required')
    expect(needs.executor.store.get(b.id)?.state).toBe('working')
  })
  it('an agent of another project is not found, and bad refs are invalid', async () => {
    const s = setup()
    const id = String((await s.spawn()).data?.agentId)
    expect((await s.run('agent.status', { projectId: 'p2', agentRef: id })).code).toBe('agent_not_found')
    expect((await s.run('agent.status', { projectId: 'p1', agentRef: '../x' })).code).toBe('invalid_shape')
    expect((await s.run('agent.read', { projectId: 'p1', agentRef: id, tail: 9999 })).code).toBe('invalid_shape')
  })
  it('results and audit events carry no token, env or path', async () => {
    const s = setup()
    const res = await s.spawn()
    const id = String(res.data?.agentId)
    const dump = JSON.stringify([res, await s.run('agent.status', { projectId: 'p1', agentRef: id }), allRows(s.f.db, 'SELECT payload_json FROM event')])
    for (const needle of ['wcap_', 'token', '/tmp/wt', 'WEBTERM_']) expect(dump.includes(needle)).toBe(false)
  })
})
