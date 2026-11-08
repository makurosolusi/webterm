// Bun-only (bun:sqlite ledger): the ladder with live inputs (daily spend vs cap, per-project override,
// the once-per-run budget notice) and how a pick lands on argv (launch profile flags, custom kinds).
import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { registerClaudeLaunchSettings } from '../claudeLauncher/claudeLauncher'
import { withLadderModel } from '../central/agents/agentExecutor'
import { freshDb } from '../central/guard/controlGuard.testutil'
import { setCostCap } from '../cost/costOracle'
import { execWrite } from '../ledger/ledgerCore'
import { claudeHeadlessArgv } from '../spawn/agentSpawn'
import { EXPLORE_AGENT_MD } from '../subagents/exploreAgent'
import { resolveModel } from './modelLadder'
import { projectModelOverride, registerModelSettings } from './modelOverride'
import { MODEL_NOTICE_SOURCE, dailyBudget, pickModel } from './modelPick'

afterEach(() => {
  registerModelSettings(() => ({}))
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
})

/** A ledger whose day cap is $1 with `spent` micros already spent today (an ended bake-off run reports its own cost). */
function ledger(spent: number) {
  const db = freshDb()
  setCostCap(db, 'day', 1_000_000)
  const now = Date.now()
  execWrite(db, 'INSERT INTO cost_run (id, kind, ref, node_id, started_at, ended_at, cost_micros) VALUES (?, ?, ?, ?, ?, ?, ?)', 'past', 'bakeoff', 'b0', 'n0', now - 1000, now - 500, spent)
  return db
}
const notices = (db: ReturnType<typeof freshDb>) =>
  db.query('SELECT title, repeat_count FROM inbox_item WHERE source = ?').all(MODEL_NOTICE_SOURCE) as Array<{ title: string; repeat_count: number }>

test('under 80% of the cap the default tier holds; no cap = no budget pressure', () => {
  expect(pickModel(ledger(500_000), { kind: 'dag-planner', runRef: 'r' })).toMatchObject({ tier: 'T3', model: 'opus' })
  expect(pickModel(freshDb(), { kind: 'dag-planner', runRef: 'r' })).toMatchObject({ tier: 'T3', model: 'opus' })
  expect(pickModel(null, { kind: 'dag-worker', complexity: 'simple', runRef: 'r' })).toMatchObject({ tier: 'T2', model: 'sonnet', effort: 'medium' })
})

test('80% caps a T3 run at sonnet, 100% at haiku; one Needs-you notice per run, however often it is asked', () => {
  const db = ledger(850_000)
  const capped = pickModel(db, { kind: 'dag-planner', runRef: 'dag:1' })
  expect(capped).toMatchObject({ tier: 'T2', model: 'sonnet' })
  expect(capped.reason.startsWith('budget:')).toBe(true)
  pickModel(db, { kind: 'dag-worker', complexity: 'complex', runRef: 'dag:1' })
  expect(notices(db)).toEqual([{ title: 'Run limited by the daily cost cap', repeat_count: 2 }])
  const full = ledger(1_000_000)
  expect(pickModel(full, { kind: 'dag-planner', runRef: 'x' })).toMatchObject({ tier: 'T1', model: 'haiku' })
  // A T2-default kind pulled down to haiku raises no notice: the cap only bites "big" runs worth telling about.
  const t2 = ledger(1_000_000)
  expect(pickModel(t2, { kind: 'routine', runRef: 'y' })).toMatchObject({ tier: 'T1', model: 'haiku' })
  expect(notices(t2)).toEqual([])
})

test('the Central daily cost budget counts as a cap too; the tighter one wins', () => {
  const db = freshDb()
  const now = Date.now()
  execWrite(db, 'INSERT INTO cost_run (id, kind, ref, node_id, started_at, ended_at, cost_micros) VALUES (?, ?, ?, ?, ?, ?, ?)', 'past', 'bakeoff', 'b0', 'n0', now - 1000, now - 500, 900_000)
  expect(dailyBudget(db, now, { WEBTERM_CENTRAL_DAILY_COST_MICROS: '1000000' })).toEqual({ spentMicros: 900_000, capMicros: 1_000_000 })
  setCostCap(db, 'day', 5_000_000)
  expect(dailyBudget(db, now, { WEBTERM_CENTRAL_DAILY_COST_MICROS: '1000000' }).capMicros).toBe(1_000_000)
})

test('the per-project override wins over the default and the budget; malformed entries are ignored', () => {
  registerModelSettings(() => ({ projectModels: { p1: { model: 'opus', effort: 'max' }, p2: { effort: 'bogus' }, p3: 'opus' } }))
  expect(pickModel(ledger(1_000_000), { kind: 'routine', workspaceId: 'p1', runRef: 'r' })).toMatchObject({ model: 'opus', effort: 'max', reason: 'user override' })
  expect(projectModelOverride('p2')).toBeNull()
  expect(projectModelOverride('p3')).toBeNull()
  expect(projectModelOverride(null)).toBeNull()
})

test('a launch profile keeps its own --model/--effort unless the pick is a user override', () => {
  registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles: [{ id: 'mine', name: 'Mine', command: 'claude --model haiku' }], defaultClaudeProfileId: 'mine' }))
  const ladder = resolveModel({ kind: 'dag-planner' })
  expect(claudeHeadlessArgv('p', undefined, ladder)).toEqual(['claude', '--model', 'haiku', '-p', 'p', '--output-format', 'json', '--effort', 'high'])
  const forced = resolveModel({ kind: 'dag-planner', override: { model: 'opus' } })
  expect(claudeHeadlessArgv('p', undefined, forced).slice(-4)).toEqual(['--model', 'opus', '--effort', 'high'])
  // No pick (T0 or an old caller): exactly the profile's argv, as before.
  expect(claudeHeadlessArgv('p')).toEqual(['claude', '--model', 'haiku', '-p', 'p', '--output-format', 'json'])
  expect(claudeHeadlessArgv('p', undefined, resolveModel({ kind: 'central', tier: 'T0' }))).toEqual(['claude', '--model', 'haiku', '-p', 'p', '--output-format', 'json'])
})

test('Central custom kinds: claude (bare or wrapped) gets the pick unless its args set it; other programs stay as defined', () => {
  const pick = resolveModel({ kind: 'agent-spawn' })
  expect(withLadderModel(['/usr/local/bin/claude', '-p', 'x'], pick)).toEqual(['/usr/local/bin/claude', '-p', 'x', '--model', 'sonnet', '--effort', 'medium'])
  expect(withLadderModel(['envman', '--', 'claude', '--model', 'opus', '-p', 'x'], pick)).toEqual(['envman', '--', 'claude', '--model', 'opus', '-p', 'x', '--effort', 'medium'])
  expect(withLadderModel(['codex', 'exec', 'x'], pick)).toEqual(['codex', 'exec', 'x'])
})

test('the explore subagent stays on haiku at low effort', () => {
  expect(EXPLORE_AGENT_MD).toContain('model: haiku\neffort: low\n')
})
