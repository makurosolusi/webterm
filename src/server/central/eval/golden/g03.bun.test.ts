// Bun-only (bun:sqlite). Golden G3 (RND/29-b §4.13): a crash mid-turn followed by a reboot leaves
// the turn `interrupted`, the conversation free again and no zombie turn behind.
import { expect, test } from 'bun:test'
import { getGoal } from '../../goalStore'
import { getConversation, getTurn } from '../../conversationStore'
import { goalInput, proposeGoal } from '../adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from '../goldenHarness'

const ACTIVE_TURNS = `SELECT COUNT(*) AS c FROM central_turn WHERE status IN ('queued', 'running', 'awaiting_approval')`

test('G3: crash mid-turn then reboot -> interrupted, conversation free, no zombie, no effect', async () => {
  // The MCP call sits AFTER the hang point: a crashed turn must never reach it.
  const crashing = [
    { text: 'partial one ' }, { text: 'partial two ' }, { hang: true } as const,
    proposeGoal(goalInput(GOLDEN_PROJECT, 'Never applied')),
  ]
  const h = await createHarness({ turns: [crashing] })
  try {
    const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-1', text: 'plan' })
    await h.hung()
    const midTurn = getTurn(h.db, submitted.response.turnId)
    expect(midTurn?.status).toBe('running')
    expect(getConversation(h.db, GOLDEN_CONVERSATION)?.activeTurnId).toBe(submitted.response.turnId)

    const reconciled = h.restart([[{ text: 'back online' }]])

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
    expect(h.count(`SELECT COUNT(*) AS c FROM event WHERE kind = 'central.proposal'`)).toBe(0)

    // Reboot is idempotent: nothing left to reconcile.
    expect(h.restart([]).turnIds.length).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('G3: after the reboot the conversation accepts a new turn and old ids replay without re-running', async () => {
  const h = await createHarness({ turns: [[{ text: 'half' }, { hang: true }]] })
  try {
    const crashed = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-2', text: 'plan' })
    await h.hung()
    h.restart([[{ text: 'fresh turn' }]])

    const replay = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'crash-2', text: 'plan' })
    expect(replay.response.turnId).toBe(crashed.response.turnId)
    expect(replay.response.status).toBe('failed')
    expect(h.calls).toBe(0)

    const next = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'after-reboot', text: 'again' })
    expect((await next.done).status).toBe('succeeded')
    expect(h.calls).toBe(1)
    expect(h.count(ACTIVE_TURNS)).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)
