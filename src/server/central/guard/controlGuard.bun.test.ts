// Bun-only. ControlGuard verdicts, caps, budget, breaker, doom-loop, audit and the WS-03 adapter.
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ControlGuard as ToolPortGuard } from '../tools/toolTypes'
import type { GuardDecision, GuardRequest } from '../contracts/level.types'
import { BREAKER_BASE_MS, BREAKER_THRESHOLD } from './breakerStore'
import { createControlGuard, DOOM_THRESHOLD, MAX_WORKERS_GLOBAL, MAX_WORKERS_PER_PROJECT, toToolGuard } from './controlGuard'
import { setLevel } from './levelStore'
import { addAgent, eventKinds, freshDb, HUMAN, run, T0 } from './controlGuard.testutil'

const DAY_MS = 86_400_000
const GATED = { WEBTERM_CENTRAL_AGENTS: 'propose' }
const AUTO = { WEBTERM_CENTRAL_AGENTS: 'auto' }

function setup(env: Record<string, string | undefined> = {}) {
  const db = freshDb()
  let t = T0
  const guard = createControlGuard({ db, now: () => t, env, random: () => 0 })
  return { db, guard, advance: (ms: number) => { t += ms }, now: () => t }
}
const req = (over: Partial<GuardRequest> = {}): GuardRequest => ({ action: 'tool', projectId: 'p1', tool: 'goal.propose', tier: 'R1', ...over })
const level = (db: Database, l: 'off' | 'observe' | 'propose' | 'act_gated' | 'act_envelope', scope: 'global' | 'project:p1' = 'global') =>
  expect(setLevel(db, { scope, level: l, actor: HUMAN, now: () => T0 }).ok).toBe(true)
const code = (d: GuardDecision) => (d.verdict === 'deny' ? d.code : d.verdict)

test('verdict follows the ladder and the tier', () => {
  const { db, guard } = setup()
  expect(code(guard.check(req({ tier: 'R0' })))).toBe('allow')
  expect(code(guard.check(req()))).toBe('allow')
  expect(code(guard.check(req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })))).toBe('level_denied')
  expect(code(guard.check(req({ tier: 'R3', tool: 'project.bootstrap' })))).toBe('needs_approval')

  const gated = setup(GATED)
  level(gated.db, 'act_gated')
  expect(code(gated.guard.check(req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })))).toBe('needs_approval')
  const auto = setup(AUTO)
  level(auto.db, 'act_envelope')
  expect(code(auto.guard.check(req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })))).toBe('allow')
  expect(code(auto.guard.check(req({ tier: 'R3', tool: 'project.bootstrap' })))).toBe('needs_approval')
  level(db, 'observe')
  expect(code(guard.check(req({ tier: 'R0' })))).toBe('allow')
  expect(code(guard.check(req()))).toBe('level_denied')
})

test('lowering the level or the project applies to the very next check', () => {
  const { db, guard } = setup(AUTO)
  level(db, 'act_envelope')
  const spawn = req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })
  expect(code(guard.check(spawn))).toBe('allow')
  level(db, 'act_gated', 'project:p1')
  expect(code(guard.check(spawn))).toBe('needs_approval')
  expect(code(guard.check({ ...spawn, projectId: 'p2' }))).toBe('allow')
  level(db, 'observe')
  expect(code(guard.check(spawn))).toBe('level_denied')
  expect(guard.effectiveLevel('p1')).toBe('observe')
})

test('halt (global off) and paused projects deny everything', () => {
  const { db, guard } = setup(AUTO)
  run(db, "UPDATE project SET status = 'paused' WHERE id = 'p1'")
  expect(code(guard.check(req({ tier: 'R0' })))).toBe('project_paused')
  expect(code(guard.check(req({ tier: 'R0', projectId: 'p2' })))).toBe('allow')
  level(db, 'off')
  expect(code(guard.check(req({ tier: 'R0', projectId: 'p2' })))).toBe('halted')
  expect(code(guard.check(req({ action: 'turn', projectId: null, tool: 'chat', tier: 'R0' })))).toBe('halted')
})

test('worker caps count live agents only: 3 per project, 5 global', () => {
  const { db, guard } = setup(AUTO)
  level(db, 'act_envelope')
  const spawn = (projectId: string) => req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2', projectId })
  for (let i = 0; i < MAX_WORKERS_PER_PROJECT; i++) addAgent(db, `a${i}`, 'p1', 'working')
  addAgent(db, 'done', 'p1', 'closed')
  addAgent(db, 'wait', 'p1', 'approval_pending')
  expect(code(guard.check(spawn('p1')))).toBe('cap_project')
  expect(code(guard.check(spawn('p2')))).toBe('allow')
  for (let i = 0; i < MAX_WORKERS_GLOBAL - MAX_WORKERS_PER_PROJECT; i++) addAgent(db, `b${i}`, 'p2', 'starting')
  expect(code(guard.check(spawn('p2')))).toBe('cap_global')
  run(db, "UPDATE central_agents SET state = 'closed' WHERE id = 'a0'")
  expect(code(guard.check(spawn('p1')))).toBe('allow')
})

test('daily spawn limit and token budget, reset by the UTC day', () => {
  const { db, guard, advance } = setup(AUTO)
  level(db, 'act_envelope')
  const spawn = req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })
  guard.recordUsage({ projectId: 'p1', turns: 1, tokens: 10, costMicros: 0, spawns: 19, wallMs: 5 })
  expect(code(guard.check(spawn))).toBe('allow')
  guard.recordUsage({ projectId: null, turns: 0, tokens: 0, costMicros: 0, spawns: 1, wallMs: 0 })
  expect(code(guard.check(spawn))).toBe('spawn_daily')
  expect(code(guard.check(req()))).toBe('allow')

  // 10M input-equivalent tokens = the registry default daily budget
  guard.recordUsage({ projectId: 'p2', turns: 1, tokens: 10_000_000, costMicros: 0, spawns: 0, wallMs: 0 })
  expect(code(guard.check(req({ action: 'turn', tool: 'chat', tier: 'R0' })))).toBe('budget_exhausted')
  expect(code(guard.check(req()))).toBe('budget_exhausted')
  expect(code(guard.check(req({ tier: 'R0' })))).toBe('allow')
  advance(DAY_MS)
  expect(code(guard.check(spawn))).toBe('allow')
  expect(code(guard.check(req({ action: 'turn', tool: 'chat', tier: 'R0' })))).toBe('allow')
})

test('budget limits come from env; 0 tokens means unlimited, 0 spawns means none', () => {
  const { db, guard } = setup({ ...AUTO, WEBTERM_CENTRAL_DAILY_TOKENS: '0', WEBTERM_CENTRAL_DAILY_SPAWNS: '0' })
  level(db, 'act_envelope')
  guard.recordUsage({ projectId: null, turns: 1, tokens: 5_000_000, costMicros: 0, spawns: 0, wallMs: 0 })
  expect(code(guard.check(req()))).toBe('allow')
  expect(code(guard.check(req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })))).toBe('spawn_daily')
})

test('project breaker blocks, then admits one half_open probe', () => {
  const { guard, advance } = setup(AUTO)
  for (let i = 0; i < BREAKER_THRESHOLD; i++) guard.breaker.trip('project:p1', 'task_failed')
  expect(code(guard.check(req()))).toBe('breaker_open')
  expect(code(guard.check(req({ projectId: 'p2' })))).toBe('allow')
  advance(BREAKER_BASE_MS)
  expect(code(guard.check(req()))).toBe('allow')
  expect(code(guard.check(req()))).toBe('breaker_open')
  guard.breaker.recordSuccess('project:p1')
  expect(code(guard.check(req()))).toBe('allow')
})

test('doom-loop: the same proposal digest repeated opens its breaker; reads and other digests are unaffected', () => {
  const { db, guard, advance } = setup()
  const same = req({ digest: 'abc123' })
  for (let i = 1; i < DOOM_THRESHOLD; i++) expect(code(guard.check(same))).toBe('allow')
  expect(code(guard.check(same))).toBe('doom_loop')
  expect(code(guard.check(same))).toBe('doom_loop')
  expect(code(guard.check(req({ digest: 'other' })))).toBe('allow')
  for (let i = 0; i < 5; i++) expect(code(guard.check(req({ tier: 'R0', digest: 'abc123' })))).toBe('allow')
  expect(guard.breaker.peek('item:abc123')?.state).toBe('open')
  expect(eventKinds(db, 'central.breaker').length).toBe(1)
  advance(BREAKER_BASE_MS * 2)
  expect(code(guard.check(same))).toBe('doom_loop')
})

test('every decision is audited with verdict and code, without free text from the request', () => {
  const { db, guard } = setup()
  guard.check(req({ tier: 'R0' }))
  guard.check(req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' }))
  const audits = eventKinds(db, 'central.guard')
  expect(audits.length).toBe(2)
  expect(audits[0]?.verdict).toBe('allow')
  expect(audits[1]?.verdict).toBe('deny')
  expect(audits[1]?.code).toBe('level_denied')
  expect(audits[1]?.projectId).toBe('p1')
})

test('tool-port adapter is structurally the registry ControlGuard and maps verdicts', () => {
  const { db, guard } = setup(GATED)
  level(db, 'act_gated')
  const port: ToolPortGuard = toToolGuard(guard)
  expect(JSON.stringify(port.check({ tool: 'goal.propose', tier: 'R1', projectId: 'p1', input: { a: 1 } }))).toBe('{"ok":true}')
  const spawn = { tool: 'agent.spawn', tier: 'R2', projectId: 'p1', input: { kind: 'opencode' } } as const
  expect(JSON.stringify(port.check(spawn))).toBe('{"ok":false,"code":"approval_required"}')
  expect(JSON.stringify(toToolGuard(guard, { approved: true }).check(spawn))).toBe('{"ok":true}')
  level(db, 'off')
  expect(JSON.stringify(port.check({ tool: 'goal.propose', tier: 'R1', projectId: 'p1', input: {} }))).toBe('{"ok":false,"code":"halted"}')
  // key order must not defeat doom-loop detection
  const fresh = setup()
  const p2 = toToolGuard(fresh.guard)
  const calls = [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 2 }].map((input) => JSON.stringify(p2.check({ tool: 'task.assign', tier: 'R1', projectId: 'p1', input })))
  expect(calls[2]).toBe('{"ok":false,"code":"doom_loop"}')
})

test('a guard failure denies with guard_error and is reported', () => {
  const { guard } = setup()
  const errors: unknown[] = []
  const boom = { ...guard, check: () => { throw new Error('db gone') } }
  const out = toToolGuard(boom, { onError: (e) => errors.push(e) }).check({ tool: 'x', tier: 'R1', input: {} })
  expect(JSON.stringify(out)).toBe('{"ok":false,"code":"guard_error"}')
  expect(errors.length).toBe(1)
})
