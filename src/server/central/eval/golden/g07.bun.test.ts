// Bun-only (bun:sqlite). Golden G7 (RND/29-b §4.13): when a budget runs out (turn, token, spawn,
// day) the server refuses with `budget_exhausted`, applies nothing and records the event.
// Per-turn limits run through the real TurnService; the day/spawn caps use the stand-in guard
// from goldenHarness (TODO(ca2-16b): swap it for the WS-07 ControlGuard).
import { expect, test } from 'bun:test'
import { getTurn } from '../../conversationStore'
import { getGoal } from '../../goalStore'
import { execTool } from '../../tools/toolExec'
import { defaultRegistry } from '../../tools/defaultRegistry'
import { createRegistry } from '../../tools/toolRegistry'
import type { ToolCtx, ToolDef } from '../../tools/toolTypes'
import { goalInput, proposalBlock } from '../adversarialPayloads'
import {
  createBudgetGuard, createHarness, DAILY_SPAWN_LIMIT, DAILY_TOKEN_LIMIT, GOLDEN_CONVERSATION, GOLDEN_PROJECT,
  setDailyUsage, type GoldenHarness,
} from '../goldenHarness'
import { opencodeRecording, type RecordedStep } from '../scriptedRuntime'

const PROPOSAL_AUDITS = `SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal'`
const proposal = () => proposalBlock('goal.propose', goalInput(GOLDEN_PROJECT, 'Must not exist'))

async function runTurn(h: GoldenHarness) {
  const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'g7', text: 'plan' })
  await submitted.done
  return getTurn(h.db, submitted.response.turnId)
}

function expectNoEffect(h: GoldenHarness): void {
  expect(getGoal(h.db, GOLDEN_PROJECT) === null).toBe(true)
  expect(h.count(PROPOSAL_AUDITS)).toBe(0)
}

test('G7 token budget per turn: budget_exhausted, proposal not applied, error event recorded', async () => {
  const steps: RecordedStep[] = [
    { kind: 'step' }, { kind: 'text', text: proposal() }, { kind: 'usage', input: 80, output: 80 },
  ]
  const h = await createHarness({ turns: [{ jsonl: opencodeRecording(steps) }], limitEnv: { WEBTERM_CENTRAL_TURN_TOKENS: '100' } })
  try {
    const turn = await runTurn(h)
    expect(turn?.status).toBe('failed')
    expect(turn?.errorCode).toBe('budget_exhausted')
    expectNoEffect(h)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_event WHERE type = 'error' AND payload_json LIKE '%budget_exhausted%'`)).toBe(1)
  } finally {
    h.cleanup()
  }
})

test('G7 step budget per turn: the round trip over the cap never runs', async () => {
  const steps: RecordedStep[] = [
    { kind: 'step' }, { kind: 'text', text: 'round one. ' }, { kind: 'usage', input: 1, output: 1 },
    { kind: 'step' }, { kind: 'text', text: proposal() }, { kind: 'usage', input: 1, output: 1 },
  ]
  const h = await createHarness({ turns: [{ jsonl: opencodeRecording(steps) }], limitEnv: { WEBTERM_CENTRAL_TURN_STEPS: '1' } })
  try {
    const turn = await runTurn(h)
    // `max_turns` is the runtime's own code for the step cap; the golden contract is "no effect + event".
    expect(turn?.status).toBe('failed')
    expect(turn?.errorCode).toBe('max_turns')
    expect(turn?.partialText).toBe('round one. ')
    expectNoEffect(h)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_event WHERE type = 'error' AND payload_json LIKE '%max_turns%'`)).toBe(1)
  } finally {
    h.cleanup()
  }
})

function toolCtx(h: GoldenHarness, registry: ToolCtx['registry']): ToolCtx {
  return {
    db: h.db, registry, guard: createBudgetGuard(h.db, h.clock, ['test.spawn']), maxTier: 'R1',
    conversationId: GOLDEN_CONVERSATION, now: h.clock.now,
  }
}

test('G7 day token budget: tool call refused with no effect, audited; under the cap it still works', async () => {
  const h = await createHarness({ turns: [] })
  try {
    const ctx = toolCtx(h, defaultRegistry())
    setDailyUsage(h.db, h.clock, { tokens: DAILY_TOKEN_LIMIT, spawns: 0 })
    const denied = await execTool(ctx, 'goal.propose', goalInput(GOLDEN_PROJECT, 'Over budget'))
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('budget_exhausted')
    expect(getGoal(h.db, GOLDEN_PROJECT) === null).toBe(true)
    expect(h.count(`SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal' AND payload_json LIKE '%budget_exhausted%'`)).toBe(1)

    setDailyUsage(h.db, h.clock, { tokens: DAILY_TOKEN_LIMIT - 1, spawns: 0 })
    const allowed = await execTool(ctx, 'goal.propose', goalInput(GOLDEN_PROJECT, 'Under budget'))
    expect(allowed.ok).toBe(true)
    expect(getGoal(h.db, GOLDEN_PROJECT)?.version).toBe(1)
  } finally {
    h.cleanup()
  }
})

test('G7 day spawn budget: the 21st spawn is refused and its handler never runs', async () => {
  const h = await createHarness({ turns: [] })
  try {
    let spawned = 0
    const spawnTool: ToolDef = {
      name: 'test.spawn', summary: 'Test-only spawn stand-in; counts handler runs.', tier: 'R1', usage: '{}',
      projectScoped: false, validate: () => null,
      handler: () => { spawned += 1; return { ok: true } },
    }
    const registry = createRegistry()
    registry.register(spawnTool)
    const ctx = toolCtx(h, registry)

    setDailyUsage(h.db, h.clock, { tokens: 0, spawns: DAILY_SPAWN_LIMIT })
    const denied = await execTool(ctx, 'test.spawn', {})
    expect(denied.code).toBe('budget_exhausted')
    expect(spawned).toBe(0)
    expect(h.count(`SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal' AND payload_json LIKE '%budget_exhausted%'`)).toBe(1)

    setDailyUsage(h.db, h.clock, { tokens: 0, spawns: DAILY_SPAWN_LIMIT - 1 })
    expect((await execTool(ctx, 'test.spawn', {})).ok).toBe(true)
    expect(spawned).toBe(1)
  } finally {
    h.cleanup()
  }
})
