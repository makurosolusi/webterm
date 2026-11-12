// Bun-only (bun:sqlite). Golden G7 (RND/29-b §4.13): when a budget runs out (turn, token, spawn,
// day) the server refuses, applies nothing and records the event. Per-turn limits are enforced by the
// runtime killing the fake Claude before its next MCP call; day/spawn caps by the real CA2 guard
// behind `webterm mcp`.
import { expect, test } from 'bun:test'
import { getTurn } from '../../conversationStore'
import { getGoal } from '../../goalStore'
import { budgetLimits } from '../../guard/budgetStore'
import { adversarialTools, goalInput, proposeGoal } from '../adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT, setDailyUsage, type GoldenHarness } from '../goldenHarness'

const PROPOSAL_AUDITS = `SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal'`
/** Longer than stopping the child takes, so a call after it only happens if the runtime failed to stop the turn. */
const AFTER_LIMIT_PAUSE_MS = 1_500
/** The day token budget defaults to none (the dollar cap is the budget), so this suite sets one. */
const DAY_TOKEN_ENV = { WEBTERM_CENTRAL_DAILY_TOKENS: '1000000' } // test-only
const DAY = budgetLimits(DAY_TOKEN_ENV)
const lateCall = () => [{ pause: AFTER_LIMIT_PAUSE_MS }, proposeGoal(goalInput(GOLDEN_PROJECT, 'Must not exist'))]

let msg = 0
async function runTurn(h: GoldenHarness) {
  const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: `g7-${++msg}`, text: 'plan' })
  await submitted.done
  return getTurn(h.db, submitted.response.turnId)
}

function expectNoEffect(h: GoldenHarness): void {
  expect(getGoal(h.db, GOLDEN_PROJECT) === null).toBe(true)
  expect(h.count(PROPOSAL_AUDITS)).toBe(0)
  expect(h.receipts()).toEqual([])
}

test('G7 token budget per turn: budget_exhausted, the next call never runs, error event recorded', async () => {
  const h = await createHarness({ turns: [[{ text: 'thinking hard', tokens: 80 }, ...lateCall()]], maxTokens: 100 })
  try {
    const turn = await runTurn(h)
    expect(turn?.status).toBe('failed')
    expect(turn?.errorCode).toBe('budget_exhausted')
    expectNoEffect(h)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_event WHERE type = 'error' AND payload_json LIKE '%budget_exhausted%'`)).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('G7 step budget per turn: the round over the cap stops the turn before its call', async () => {
  const h = await createHarness({ turns: [[{ text: 'round one. ' }, { text: 'round two. ' }, ...lateCall()]], limitEnv: { WEBTERM_CENTRAL_TURN_STEPS: '1' } })
  try {
    const turn = await runTurn(h)
    // `max_turns` is the runtime's own code for the step cap; the golden contract is "no effect + event".
    expect(turn?.status).toBe('failed')
    expect(turn?.errorCode).toBe('max_turns')
    expect(turn?.partialText?.startsWith('round one. ')).toBe(true)
    expectNoEffect(h)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_event WHERE type = 'error' AND payload_json LIKE '%max_turns%'`)).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('G7 day token budget: the MCP call is refused with no effect and audited; under the cap it works', async () => {
  const h = await createHarness({
    turns: [[proposeGoal(goalInput(GOLDEN_PROJECT, 'Over budget'))], [proposeGoal(goalInput(GOLDEN_PROJECT, 'Under budget'))]],
    guardEnv: DAY_TOKEN_ENV,
  })
  try {
    setDailyUsage(h.db, { tokens: DAY.tokens, spawns: 0 })
    await runTurn(h)
    expect(h.receipts().map((r) => r.errorCode)).toEqual(['budget_exhausted'])
    expect(getGoal(h.db, GOLDEN_PROJECT) === null).toBe(true)
    expect(h.count(`SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal' AND payload_json LIKE '%budget_exhausted%'`)).toBe(1)

    setDailyUsage(h.db, { tokens: DAY.tokens - 1, spawns: 0 })
    await runTurn(h)
    expect(h.receipts()[1]).toMatchObject({ ok: true })
    expect(getGoal(h.db, GOLDEN_PROJECT)?.version).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('G7 day spawn budget: the spawn over the cap is refused and its handler never runs', async () => {
  let spawned = 0
  const spawn = (n: number) => [{ call: 'agent_spawn', args: { projectId: GOLDEN_PROJECT, count: n } }]
  const h = await createHarness({ turns: [spawn(1), spawn(2)], tools: adversarialTools(() => { spawned += 1 }, '') })
  try {
    setDailyUsage(h.db, { tokens: 0, spawns: DAY.spawns })
    await runTurn(h)
    expect(h.receipts().map((r) => r.errorCode)).toEqual(['spawn_daily'])
    expect(spawned).toBe(0)

    setDailyUsage(h.db, { tokens: 0, spawns: DAY.spawns - 1 })
    await runTurn(h)
    expect(h.receipts()[1]).toMatchObject({ ok: true })
    expect(spawned).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)
