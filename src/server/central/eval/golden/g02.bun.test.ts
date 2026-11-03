// Bun-only (bun:sqlite). Golden G2 (RND/29-b §4.13): replaying one clientMessageId / Telegram
// update_id 100x must leave exactly 1 message, 1 turn and 1 applied action.
import { expect, test } from 'bun:test'
import { getGoal } from '../../goalStore'
import { answerSteps, goalInput, proposalBlock } from '../adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from '../goldenHarness'
import { opencodeRecording } from '../scriptedRuntime'

const REPLAYS = 100
// Channel update ids become clientMessageIds (`tg:<update_id>`); the dispatcher itself is WS-12.
const UPDATE_ID = 'tg:update:90210' // test-only
const turn = (statement: string) => ({
  jsonl: opencodeRecording(answerSteps(proposalBlock('goal.propose', goalInput(GOLDEN_PROJECT, statement)))),
})

test('G2: 100 replays while the turn runs and 100 after it ends -> 1 message, 1 turn, 1 action', async () => {
  const h = await createHarness({ turns: [turn('Ship it')] })
  try {
    const submit = (clientMessageId: string) =>
      h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId, text: 'plan it' })
    const duringRun = Array.from({ length: REPLAYS }, () => submit(UPDATE_ID))
    const first = duringRun[0]!
    expect(new Set(duringRun.map((r) => r.response.turnId)).size).toBe(1)
    expect(new Set(duringRun.map((r) => r.response.messageId)).size).toBe(1)
    expect((await first.done).status).toBe('succeeded')

    const afterRun = Array.from({ length: REPLAYS }, () => submit(UPDATE_ID))
    expect(afterRun.every((r) => r.response.turnId === first.response.turnId)).toBe(true)
    expect(afterRun.every((r) => r.response.messageId === first.response.messageId)).toBe(true)

    expect(h.count(`SELECT COUNT(*) AS c FROM central_message WHERE role = 'human'`)).toBe(1)
    expect(h.count('SELECT COUNT(*) AS c FROM central_turn')).toBe(1)
    expect(h.runtime.calls).toBe(1)
    expect(getGoal(h.db, GOLDEN_PROJECT)?.version).toBe(1)
    expect(h.count(`SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal'`)).toBe(1)
  } finally {
    h.cleanup()
  }
})

test('G2 control: a different clientMessageId is NOT deduplicated', async () => {
  const h = await createHarness({ turns: [turn('First'), { jsonl: opencodeRecording(answerSteps('plain answer')) }] })
  try {
    const one = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'tg:update:1', text: 'a' })
    await one.done
    const two = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'tg:update:2', text: 'b' })
    await two.done
    expect(two.response.turnId).not.toBe(one.response.turnId)
    expect(h.count('SELECT COUNT(*) AS c FROM central_turn')).toBe(2)
    expect(h.runtime.calls).toBe(2)
    expect(getGoal(h.db, GOLDEN_PROJECT)?.version).toBe(1)
  } finally {
    h.cleanup()
  }
})
