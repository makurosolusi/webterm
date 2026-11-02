// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are typed (see src/server/bun-test.d.ts).
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openLedgerDb } from '../ledger/migration'
import {
  appendConversationEvent,
  appendMessage,
  cancelTurn,
  createTurn,
  getConversation,
  getOrCreateConversation,
  getTurn,
  listConversationEvents,
  updateTurn,
} from './conversationStore'

type Row = Record<string, unknown>
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}
function q(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}
function close(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}
function count(db: Database, sql: string, ...params: unknown[]): number {
  return Number(q(db, sql).get(...params)?.['c'] ?? -1)
}
function expectThrow(fn: () => unknown, contains: string): void {
  let message = ''
  try {
    fn()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message.length > 0).toBe(true)
  expect(message).toContain(contains)
}
function freshDb(): Database {
  return openLedgerDb(':memory:')
}
const text = [{ type: 'text', text: 'hello' }]

test('conversation mapping is canonical and idempotent per scope', () => {
  const db = freshDb()
  const global = getOrCreateConversation(db, 'global', 10)
  expect(global.id).toBe('central:global')
  expect(global.scope).toBe('global')
  expect(global.projectId).toBe(null)
  expect(global.lastMessageSeq).toBe(0)
  expect(global.lastEventSeq).toBe(0)
  const again = getOrCreateConversation(db, 'global', 99)
  expect(again.createdAt).toBe(10)
  expect(count(db, 'SELECT count(*) AS c FROM central_conversation')).toBe(1)

  const project = getOrCreateConversation(db, 'project:p1')
  expect(project.id).toBe('central:project:p1')
  expect(project.scope).toBe('project:p1')
  expect(project.projectId).toBe('p1')
  expect(getConversation(db, 'central:project:p1')?.id).toBe('central:project:p1')
  expect(getConversation(db, 'central:global')?.id).toBe('central:global')
  expect(getConversation(db, 'central:project:missing')).toBe(null)
  expectThrow(() => getConversation(db, 'central:task:t1'), 'invalid_conversation')
  expectThrow(() => getOrCreateConversation(db, 'project:'), 'invalid_conversation')
  close(db)
})

test('messages get monotonic per-conversation seq independently and expose turn_id', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  const first = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text, now: 1 })
  const second = appendMessage(db, { conversationId: 'central:global', role: 'assistant', parts: text, now: 2 })
  expect(first.created).toBe(true)
  expect(first.message.seq).toBe(1)
  expect(second.message.seq).toBe(2)
  expect(second.message.role).toBe('assistant')
  expect(getConversation(db, 'central:global')?.lastMessageSeq).toBe(2)
  expectThrow(() => appendMessage(db, { conversationId: 'central:global', role: 'robot', parts: text }), 'invalid_role')

  getOrCreateConversation(db, 'project:p1')
  const other = appendMessage(db, { conversationId: 'central:project:p1', role: 'human', parts: text })
  expect(other.message.seq).toBe(1)
  close(db)
})

test('clientMessageId replay returns the original message and consumes no seq', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  const first = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text, clientMessageId: 'c-1', now: 5 })
  const replay = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text, clientMessageId: 'c-1', now: 9 })
  expect(replay.created).toBe(false)
  expect(replay.message.id).toBe(first.message.id)
  expect(replay.message.seq).toBe(1)
  expect(count(db, 'SELECT count(*) AS c FROM central_message')).toBe(1)
  expect(getConversation(db, 'central:global')?.lastMessageSeq).toBe(1)

  // The same client id is legal in a different conversation (per-scope dedupe).
  getOrCreateConversation(db, 'project:p1')
  const scoped = appendMessage(db, { conversationId: 'central:project:p1', role: 'human', parts: text, clientMessageId: 'c-1' })
  expect(scoped.created).toBe(true)
  expect(scoped.message.seq).toBe(1)
  close(db)
})

test('message parts are persisted with secrets redacted', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  appendMessage(db, {
    conversationId: 'central:global',
    role: 'tool',
    parts: [
      { type: 'text', text: 'done' },
      { type: 'tool', toolCallId: 'c1', name: 'mcp__webterm__portfolio.read', state: 'succeeded', args: { apiKey: 'sk-live-abcdefghijklmnop' } },
    ],
  })
  const parts = String(q(db, 'SELECT parts_json FROM central_message').get()?.['parts_json'])
  expect(parts).toContain('[redacted]')
  expect(parts).toContain('done')
  expect(parts).not.toContain('sk-live')
  close(db)
})

test('one active turn per conversation; terminal status clears the lock', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  const m1 = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text }).message
  const m2 = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text }).message
  const turn = createTurn(db, { conversationId: 'central:global', messageId: m1.id, runtime: 'mock', now: 10 })
  expect(turn.status).toBe('running')
  expect(turn.runtime).toBe('mock')
  expect(getConversation(db, 'central:global')?.activeTurnId).toBe(turn.id)
  expect(String(q(db, 'SELECT turn_id FROM central_message WHERE id = ?').get(m1.id)?.['turn_id'])).toBe(turn.id)

  expectThrow(() => createTurn(db, { conversationId: 'central:global', messageId: m2.id }), 'conversation_busy')
  const done = updateTurn(db, { turnId: turn.id, status: 'succeeded', usage: { inputTokens: 3 }, now: 20 })
  expect(done.status).toBe('succeeded')
  expect(done.endedAt).toBe(20)
  expect(JSON.stringify(done.usage)).toBe('{"inputTokens":3}')
  expect(getConversation(db, 'central:global')?.activeTurnId).toBe(null)
  // The lock is free again, so a new turn is accepted.
  const next = createTurn(db, { conversationId: 'central:global', messageId: m2.id })
  expect(next.id === turn.id).toBe(false)
  expectThrow(() => updateTurn(db, { turnId: turn.id, status: 'running' }), 'invalid_transition')
  close(db)
})

test('cancel is idempotent, stores partial text, and rejects terminal turns', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  const message = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text }).message
  const turn = createTurn(db, { conversationId: 'central:global', messageId: message.id })
  const cancelled = cancelTurn(db, turn.id, 'partial answer', 30)
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.partialText).toBe('partial answer')
  expect(cancelled.endedAt).toBe(30)
  const again = cancelTurn(db, turn.id, 'ignored', 40)
  expect(again.status).toBe('cancelled')
  expect(again.partialText).toBe('partial answer')
  expect(getConversation(db, 'central:global')?.activeTurnId).toBe(null)
  expectThrow(() => cancelTurn(db, 'missing-turn'), 'turn_not_active')
  expectThrow(() => updateTurn(db, { turnId: turn.id, status: 'running' }), 'invalid_transition')
  expect(getTurn(db, turn.id)?.status).toBe('cancelled')
  close(db)
})

test('turn creation validates message ownership per conversation', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  getOrCreateConversation(db, 'project:p1')
  const globalMessage = appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text }).message
  expectThrow(
    () => createTurn(db, { conversationId: 'central:project:p1', messageId: globalMessage.id }),
    'message_not_found'
  )
  expectThrow(() => createTurn(db, { conversationId: 'central:project:p1', messageId: 'nope' }), 'message_not_found')
  // A failed attempt must not leave a lock behind.
  const ok = createTurn(db, { conversationId: 'central:global', messageId: globalMessage.id })
  expect(ok.status).toBe('running')
  close(db)
})

test('event seq is monotonic per conversation and replay filters by seq', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  const one = appendConversationEvent(db, { conversationId: 'central:global', type: 'message.created', payload: { n: 1 }, now: 1 })
  const two = appendConversationEvent(db, { conversationId: 'central:global', type: 'part.delta', payload: { n: 2 }, now: 2 })
  const three = appendConversationEvent(db, { conversationId: 'central:global', type: 'done', payload: { n: 3 }, now: 3 })
  expect(`${one.seq},${two.seq},${three.seq}`).toBe('1,2,3')
  expect(getConversation(db, 'central:global')?.lastEventSeq).toBe(3)
  const replay = listConversationEvents(db, 'central:global', 1)
  expect(replay.map((e) => e.seq).join(',')).toBe('2,3')
  expect(replay[1]?.type).toBe('done')

  getOrCreateConversation(db, 'project:p1')
  const isolated = appendConversationEvent(db, { conversationId: 'central:project:p1', type: 'done' })
  expect(isolated.seq).toBe(1)
  expectThrow(
    () => appendConversationEvent(db, { conversationId: 'central:global', type: 'turn.done' }),
    'invalid_event'
  )
  close(db)
})

test('event payloads redact secrets before persistence', () => {
  const db = freshDb()
  getOrCreateConversation(db, 'global')
  appendConversationEvent(db, {
    conversationId: 'central:global',
    type: 'tool.completed',
    payload: { token: 'wcap_abcdefgh', nested: { password: 'hunter2', ok: true } },
  })
  const payload = String(q(db, 'SELECT payload_json FROM central_event').get()?.['payload_json'])
  expect(payload).toContain('[redacted]')
  expect(payload).not.toContain('wcap_')
  expect(payload).not.toContain('hunter2')
  expect(payload).toContain('"ok":true')
  close(db)
})

test('missing conversation and bad limits are typed errors', () => {
  const db = freshDb()
  expectThrow(() => appendMessage(db, { conversationId: 'central:global', role: 'human', parts: text }), 'conversation_not_found')
  expectThrow(() => appendConversationEvent(db, { conversationId: 'central:global', type: 'done' }), 'conversation_not_found')
  expectThrow(() => listConversationEvents(db, 'central:global'), 'conversation_not_found')
  expectThrow(() => appendMessage(db, { conversationId: 'central:task:t1', role: 'human', parts: text }), 'invalid_conversation')
  getOrCreateConversation(db, 'global')
  const event = appendConversationEvent(db, { conversationId: 'central:global', type: 'done' })
  expect(event.seq).toBe(1)
  expectThrow(() => listConversationEvents(db, 'central:global', 0, -1), 'invalid_limit')
  close(db)
})
