// Bun-only (bun:sqlite). Golden G3 (RND/29-b §4.13): a crash mid-turn followed by a reboot leaves
// the turn `interrupted`, the conversation free again and no zombie turn behind.
import { expect, test } from 'bun:test'
import { getGoal } from '../../goalStore'
import { getConversation, getTurn } from '../../conversationStore'
import { answerSteps, goalInput, proposalBlock } from '../adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from '../goldenHarness'
import { opencodeRecording } from '../scriptedRuntime'

const ACTIVE_TURNS = `SELECT COUNT(*) AS c FROM central_turn WHERE status IN ('queued', 'running', 'awaiting_approval')`

test('G3: crash mid-turn then reboot -> interrupted, conversation free, no zombie, no effect', async () => {
  // The proposal sits AFTER the hang point: a crashed turn must never apply it.
  const crashing = opencodeRecording([
    { kind: 'step' },
    { kind: 'text', text: 'partial one ' },
    { kind: 'text', text: 'partial two ' },
    { kind: 'text', text: proposalBlock('goal.propose', goalInput(GOLDEN_PROJECT, 'Never applied')) },
    { kind: 'usage', input: 5, output: 5 },
  ])
  const h = await createHarness({ turns: [{ jsonl: crashing, hangAfterLine: 3 }] })
  try {
    const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-1', text: 'plan' })
    await h.runtime.hung
    const midTurn = getTurn(h.db, submitted.response.turnId)
    expect(midTurn?.status).toBe('running')
    expect(getConversation(h.db, GOLDEN_CONVERSATION)?.activeTurnId).toBe(submitted.response.turnId)

    const reconciled = h.restart([{ jsonl: opencodeRecording(answerSteps('back online')) }])

    expect(reconciled.turnIds.join(',')).toBe(submitted.response.turnId)
    const turn = getTurn(h.db, submitted.response.turnId)
    expect(turn?.status).toBe('failed')
    expect(turn?.errorCode).toBe('interrupted')
    expect(turn?.partialText).toBe('partial one partial two ')
    expect(turn?.endedAt === null).toBe(false)
    expect(h.count(`SELECT COUNT(*) AS c FROM central_message WHERE turn_id = ? AND role = 'assistant' AND state = 'failed'`, turn?.id)).toBe(1)
    expect(h.count(ACTIVE_TURNS)).toBe(0)
    expect(getConversation(h.db, GOLDEN_CONVERSATION)?.activeTurnId === null).toBe(true)
    expect(getGoal(h.db, GOLDEN_PROJECT) === null).toBe(true)

    // Reboot is idempotent: nothing left to reconcile.
    expect(h.restart([]).turnIds.length).toBe(0)
  } finally {
    h.cleanup()
  }
})

test('G3: after the reboot the conversation accepts a new turn and old ids replay without re-running', async () => {
  const crashing = opencodeRecording([{ kind: 'step' }, { kind: 'text', text: 'half' }, { kind: 'usage', input: 1, output: 1 }])
  const h = await createHarness({ turns: [{ jsonl: crashing, hangAfterLine: 2 }] })
  try {
    const crashed = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-2', text: 'plan' })
    await h.runtime.hung
    h.restart([{ jsonl: opencodeRecording(answerSteps('fresh turn')) }])

    const replay = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-2', text: 'plan' })
    expect(replay.response.turnId).toBe(crashed.response.turnId)
    expect(replay.response.status).toBe('failed')
    expect(h.runtime.calls).toBe(0)

    const next = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'after-reboot', text: 'again' })
    expect((await next.done).status).toBe('succeeded')
    expect(h.runtime.calls).toBe(1)
    expect(h.count(ACTIVE_TURNS)).toBe(0)
  } finally {
    h.cleanup()
  }
})
