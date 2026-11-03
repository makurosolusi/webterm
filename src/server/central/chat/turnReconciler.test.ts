import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRow } from '../../ledger/ledgerCore'
import { openFixture, type Fixture } from '../centralTestFixture.testutil'
import {
  appendConversationEvent, appendMessage, createTurn, getConversation, getOrCreateConversation,
  getTurn, listConversationEvents, updateTurn,
} from '../conversationStore'
import { appendAssistantMessage } from './turnPersistence'
import { reconcileTurns } from './turnReconciler'

const T0 = 1_700_000_000_000
let fixture: Fixture
beforeEach(() => {
  fixture = openFixture()
  getOrCreateConversation(fixture.db, 'global', T0)
})
afterEach(() => fixture.close())

function startTurn(clientId: string, status?: 'queued' | 'running') {
  const human = appendMessage(fixture.db, {
    conversationId: 'central:global', role: 'human', parts: [{ type: 'text', text: 'hi' }], clientMessageId: clientId, now: T0,
  }).message
  const turn = createTurn(fixture.db, { conversationId: 'central:global', messageId: human.id, now: T0, ...(status ? { status } : {}) })
  const assistant = appendAssistantMessage(fixture.db, 'central:global', turn.id, () => T0)
  return { turn, assistant }
}

describe('reconcileTurns (B2)', () => {
  it('fails a running turn as interrupted, keeps streamed text, frees the conversation', () => {
    const { turn, assistant } = startTurn('c1')
    for (const delta of ['Hel', 'lo']) {
      appendConversationEvent(fixture.db, {
        conversationId: 'central:global', type: 'part.delta', turnId: turn.id, messageId: assistant.id,
        payload: { messageId: assistant.id, part: 'text', delta }, now: T0,
      })
    }
    expect(getConversation(fixture.db, 'central:global')!.activeTurnId).toBe(turn.id)

    const result = reconcileTurns(fixture.db, T0 + 5_000)

    expect(result.turnIds).toEqual([turn.id])
    const after = getTurn(fixture.db, turn.id)!
    expect(after).toMatchObject({ status: 'failed', errorCode: 'interrupted', partialText: 'Hello', endedAt: T0 + 5_000 })
    expect(getConversation(fixture.db, 'central:global')!.activeTurnId).toBe(null)
    const row = getRow(fixture.db, 'SELECT parts_json, state FROM central_message WHERE id = ?', assistant.id)!
    expect(row['state']).toBe('failed')
    expect(JSON.parse(String(row['parts_json']))).toEqual([{ type: 'text', text: 'Hello' }])
    const types = listConversationEvents(fixture.db, 'central:global', 0, 500).map((event) => event.type)
    expect(types.slice(-2)).toEqual(['turn.status', 'done'])
  })

  it('fails a queued turn without partial text', () => {
    const { turn } = startTurn('c1', 'queued')
    reconcileTurns(fixture.db, T0 + 1)
    expect(getTurn(fixture.db, turn.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted', partialText: null })
  })

  it('leaves terminal turns and live turns alone, and is idempotent', () => {
    const done = startTurn('c1')
    updateTurn(fixture.db, { turnId: done.turn.id, status: 'succeeded', now: T0 + 1 })
    const live = startTurn('c2')

    const result = reconcileTurns(fixture.db, T0 + 2, { liveTurnIds: new Set([live.turn.id]) })
    expect(result.turnIds).toEqual([])
    expect(getTurn(fixture.db, done.turn.id)!.status).toBe('succeeded')
    expect(getTurn(fixture.db, live.turn.id)!.status).toBe('running')
    expect(getConversation(fixture.db, 'central:global')!.activeTurnId).toBe(live.turn.id)

    expect(reconcileTurns(fixture.db, T0 + 3).turnIds).toEqual([live.turn.id])
    expect(reconcileTurns(fixture.db, T0 + 4)).toEqual({ turnIds: [], clearedConversations: 0 })
  })

  it('clears a dangling active_turn_id that points at a terminal turn', () => {
    const { turn } = startTurn('c1')
    updateTurn(fixture.db, { turnId: turn.id, status: 'succeeded', now: T0 + 1 })
    fixture.db.query('UPDATE central_conversation SET active_turn_id = ? WHERE id = ?').run(turn.id, 'central:global')

    expect(reconcileTurns(fixture.db, T0 + 2)).toEqual({ turnIds: [], clearedConversations: 1 })
    expect(getConversation(fixture.db, 'central:global')!.activeTurnId).toBe(null)
  })
})
