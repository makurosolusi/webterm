// Bun-only. Settings > Skip approvals: every ask becomes allow (audited `skipped`), every deny stays.
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { GuardDecision, GuardRequest } from '../contracts/level.types'
import { createControlGuard, toToolGuard } from './controlGuard'
import { setLevel } from './levelStore'
import { eventKinds, freshDb, HUMAN, run, T0 } from './controlGuard.testutil'

const GATED = { WEBTERM_CENTRAL_AGENTS: 'propose' }
const AUTO = { WEBTERM_CENTRAL_AGENTS: 'auto' }

function setup(env: Record<string, string | undefined>, skip: boolean) {
  const db = freshDb()
  const flag = { on: skip }
  const guard = createControlGuard({ db, now: () => T0, env, random: () => 0, skipApprovals: () => flag.on })
  return { db, guard, flag }
}
const req = (over: Partial<GuardRequest> = {}): GuardRequest => ({ action: 'tool', projectId: 'p1', tool: 'goal.propose', tier: 'R1', ...over })
const spawn = req({ action: 'spawn', tool: 'agent.spawn', tier: 'R2' })
const r3 = req({ tier: 'R3', tool: 'project.bootstrap' })
const level = (db: Database, l: 'off' | 'observe' | 'act_gated' | 'act_envelope') => expect(setLevel(db, { scope: 'global', level: l, actor: HUMAN, now: () => T0 }).ok).toBe(true)
const code = (d: GuardDecision) => (d.verdict === 'deny' ? d.code : d.verdict)

test('skip on: R2 at act_gated, R3 at act_envelope and a policy ask all allow, audited as skipped', () => {
  const gated = setup(GATED, true)
  level(gated.db, 'act_gated')
  expect(code(gated.guard.check(spawn))).toBe('allow')
  const auto = setup(AUTO, true)
  level(auto.db, 'act_envelope')
  expect(code(auto.guard.check(r3))).toBe('allow')
  auto.guard.policy.createGrant('human-ui', { subject: 'central', capability: 'goal.*', scope: 'project:p1', effect: 'ask' })
  expect(code(auto.guard.check(req()))).toBe('allow')
  expect(eventKinds(auto.db, 'central.guard').map((e) => e.skipped)).toEqual([true, true])
  expect(gated.guard.skipsApprovals()).toBe(true)
  expect(toToolGuard(gated.guard).skipsApprovals()).toBe(true)
})

test('skip on: halt, pause, level_denied, policy deny and budget still deny', () => {
  const { db, guard } = setup(AUTO, true)
  level(db, 'observe')
  expect(code(guard.check(spawn))).toBe('level_denied')
  level(db, 'act_envelope')
  guard.policy.createGrant('human-ui', { subject: 'central', capability: 'goal.propose', effect: 'deny' })
  expect(code(guard.check(req()))).toBe('policy_denied')
  guard.recordUsage({ projectId: null, turns: 0, tokens: 0, costMicros: 0, spawns: 20, wallMs: 0 })
  expect(code(guard.check(spawn))).toBe('spawn_daily')
  run(db, "UPDATE project SET status = 'paused' WHERE id = 'p1'")
  expect(code(guard.check(r3))).toBe('project_paused')
  level(db, 'off')
  expect(code(guard.check(r3))).toBe('halted')
  expect(eventKinds(db, 'central.guard').some((e) => e.skipped)).toBe(false)
})

test('skip off asks as before, and the switch is read fresh on every check', () => {
  const { db, guard, flag } = setup(GATED, false)
  level(db, 'act_gated')
  expect(code(guard.check(spawn))).toBe('needs_approval')
  expect(guard.skipsApprovals()).toBe(false)
  flag.on = true
  expect(code(guard.check(spawn))).toBe('allow')
  flag.on = false
  expect(code(guard.check(spawn))).toBe('needs_approval')
  expect(createControlGuard({ db, now: () => T0, env: GATED }).skipsApprovals()).toBe(false)
})
