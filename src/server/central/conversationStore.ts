/**
 * Conversation persistence (schema v4): conversation mapping, message history,
 * turns with a per-conversation lock, and the append-only SSE event log. Two
 * independent sequences: `central_message.seq` (history) and `central_event.seq`
 * (replay). Every write runs in one BEGIN IMMEDIATE so allocator + insert agree.
 */
import type { Database } from 'bun:sqlite'
import { writeTx } from './writeTx'
import { allRows, execWrite, getRow, newId, type Row } from '../ledger/ledgerCore'
import {
  type CentralEventType, type ConversationErrorCode, type ConversationScope,
  ConversationError, type MessagePart, type MessageRole, type MessageState,
  type TurnStatus, assertTurnTransition, conversationIdForScope, isActiveTurnStatus,
  normalizeClientMessageId, parseScope, scopeFromConversationId,
  validateEventType, validateMessageRole, validateMessageState, validateParts,
  validateTurnStatus,
} from './conversationModel'
import { PERSIST_LIMITS, redactValue } from '../redactSecrets'

export interface Conversation {
  id: string; scope: string; projectId: string | null; activeTurnId: string | null
  lastEventSeq: number; lastMessageSeq: number; createdAt: number; updatedAt: number
}
export interface Message {
  id: string; conversationId: string; seq: number; role: MessageRole
  parts: MessagePart[]; clientMessageId: string | null; turnId: string | null
  state: MessageState; createdAt: number
}
export interface Turn {
  id: string; conversationId: string; messageId: string; status: TurnStatus
  runtime: string | null; sessionRef: string | null; partialText: string | null
  usage: unknown; errorCode: string | null; startedAt: number; endedAt: number | null
}
export interface ConversationEvent {
  conversationId: string; seq: number; type: CentralEventType
  turnId: string | null; messageId: string | null; payload: unknown; createdAt: number
}
export interface AppendMessageInput {
  conversationId: string; role: unknown; parts: unknown; clientMessageId?: unknown
  turnId?: string | null; state?: unknown; now?: number; id?: string
}
export interface AppendMessageResult { message: Message; created: boolean }
export interface CreateTurnInput {
  conversationId: string; messageId: string; runtime?: string | null
  status?: unknown; now?: number; id?: string
}
export interface UpdateTurnInput {
  turnId: string; status: unknown; partialText?: string | null; usage?: unknown
  sessionRef?: string | null; errorCode?: string | null; now?: number
}
export interface AppendConversationEventInput {
  conversationId: string; type: unknown; turnId?: string | null
  messageId?: string | null; payload?: unknown; now?: number
}
function fail(code: ConversationErrorCode, message: string): never {
  throw new ConversationError(code, message)
}
const optional = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const parse = (v: unknown): unknown => (v === null || v === undefined ? null : JSON.parse(String(v)))
function toConversation(r: Row): Conversation {
  return {
    id: String(r['id']), scope: String(r['scope']), projectId: optional(r['project_id']),
    activeTurnId: optional(r['active_turn_id']), lastEventSeq: Number(r['last_event_seq']),
    lastMessageSeq: Number(r['last_message_seq']), createdAt: Number(r['created_at']), updatedAt: Number(r['updated_at']),
  }
}
function toMessage(r: Row): Message {
  return {
    id: String(r['id']), conversationId: String(r['conversation_id']), seq: Number(r['seq']),
    role: String(r['role']) as MessageRole, parts: parse(r['parts_json']) as MessagePart[],
    clientMessageId: optional(r['client_message_id']), turnId: optional(r['turn_id']),
    state: String(r['state']) as MessageState, createdAt: Number(r['created_at']),
  }
}
function toTurn(r: Row): Turn {
  return {
    id: String(r['id']), conversationId: String(r['conversation_id']), messageId: String(r['message_id']),
    status: String(r['status']) as TurnStatus, runtime: optional(r['runtime']),
    sessionRef: optional(r['session_ref']), partialText: optional(r['partial_text']),
    usage: parse(r['usage_json']), errorCode: optional(r['error_code']), startedAt: Number(r['started_at']),
    endedAt: r['ended_at'] === null || r['ended_at'] === undefined ? null : Number(r['ended_at']),
  }
}
function toEvent(r: Row): ConversationEvent {
  return {
    conversationId: String(r['conversation_id']), seq: Number(r['seq']), type: String(r['type']) as CentralEventType,
    turnId: optional(r['turn_id']), messageId: optional(r['message_id']),
    payload: parse(r['payload_json']), createdAt: Number(r['created_at']),
  }
}

function validateConversationId(raw: unknown): string {
  if (typeof raw !== 'string') fail('invalid_conversation', 'conversationId must be a string')
  return conversationIdForScope(scopeFromConversationId(raw))
}
function requireConversation(db: Database, id: string): Conversation {
  const row = getRow(db, 'SELECT * FROM central_conversation WHERE id = ?', id)
  if (!row) fail('conversation_not_found', `conversation not found: ${id}`)
  return toConversation(row)
}
function requireTurn(db: Database, turnId: string): Turn {
  const turn = getTurn(db, turnId)
  if (!turn) fail('turn_not_found', `turn not found: ${turnId}`)
  return turn
}
function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) fail('invalid_limit', `limit must be positive, got ${value}`)
  return Math.min(500, Math.trunc(value))
}
/** Returns the one canonical conversation for a scope, creating it on first use. */
export function getOrCreateConversation(db: Database, rawScope: unknown, now?: number): Conversation {
  const scope: ConversationScope = parseScope(rawScope)
  const id = conversationIdForScope(scope)
  const ts = now ?? Date.now()
  return writeTx(db, (txDb) => {
    const existing = getRow(txDb, 'SELECT * FROM central_conversation WHERE id = ?', id)
    if (existing) return toConversation(existing)
    execWrite(
      txDb,
      `INSERT INTO central_conversation (id, scope, project_id, active_turn_id, last_event_seq,
        last_message_seq, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)`,
      id, scope.kind === 'global' ? 'global' : `project:${scope.projectId}`,
      scope.kind === 'project' ? scope.projectId : null, ts, ts
    )
    return requireConversation(txDb, id)
  })
}
export function getConversation(db: Database, rawId: string): Conversation | null {
  const row = getRow(db, 'SELECT * FROM central_conversation WHERE id = ?', validateConversationId(rawId))
  return row ? toConversation(row) : null
}
export function getTurn(db: Database, turnId: string): Turn | null {
  const row = getRow(db, 'SELECT * FROM central_turn WHERE id = ?', turnId)
  return row ? toTurn(row) : null
}
/** Appends a message with idempotent `clientMessageId` and a monotonic per-conversation seq. */
export function appendMessage(db: Database, input: AppendMessageInput): AppendMessageResult {
  const conversationId = validateConversationId(input.conversationId)
  const role = validateMessageRole(input.role)
  const parts = validateParts(input.parts)
  const state = input.state === undefined ? 'complete' : validateMessageState(input.state)
  const clientMessageId = normalizeClientMessageId(input.clientMessageId)
  const ts = input.now ?? Date.now()
  const findExisting = (txDb: Database): Row | null =>
    clientMessageId === null ? null : getRow(
      txDb, 'SELECT * FROM central_message WHERE conversation_id = ? AND client_message_id = ?',
      conversationId, clientMessageId
    )
  return writeTx(db, (txDb) => {
    const conversation = requireConversation(txDb, conversationId)
    const existing = findExisting(txDb)
    if (existing) return { message: toMessage(existing), created: false }
    const seq = conversation.lastMessageSeq + 1
    const id = input.id ?? newId()
    const stored = redactValue(parts, PERSIST_LIMITS) as MessagePart[]
    try {
      execWrite(
        txDb,
        `INSERT INTO central_message (id, conversation_id, seq, role, parts_json,
          client_message_id, turn_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, conversationId, seq, role, JSON.stringify(stored), clientMessageId,
        input.turnId ?? null, state, ts
      )
    } catch (err) {
      const winner = findExisting(txDb)
      if (winner) return { message: toMessage(winner), created: false }
      throw err
    }
    execWrite(txDb, 'UPDATE central_conversation SET last_message_seq = ?, updated_at = ? WHERE id = ?', seq, ts, conversationId)
    return {
      message: {
        id, conversationId, seq, role, parts: stored, clientMessageId,
        turnId: input.turnId ?? null, state, createdAt: ts,
      },
      created: true,
    }
  })
}

/**
 * Creates the active turn for a message. A live `active_turn_id` yields
 * `conversation_busy`; a stale pointer (turn gone or terminal) is cleared.
 */
export function createTurn(db: Database, input: CreateTurnInput): Turn {
  const conversationId = validateConversationId(input.conversationId)
  const status = input.status === undefined ? 'running' : validateTurnStatus(input.status)
  if (!isActiveTurnStatus(status)) fail('invalid_turn_status', 'a new turn must be active')
  const ts = input.now ?? Date.now()
  const id = input.id ?? newId()
  return writeTx(db, (txDb) => {
    const conversation = requireConversation(txDb, conversationId)
    if (conversation.activeTurnId !== null) {
      const active = getRow(txDb, 'SELECT * FROM central_turn WHERE id = ?', conversation.activeTurnId)
      if (active && isActiveTurnStatus(String(active['status']) as TurnStatus)) {
        fail('conversation_busy', `active turn ${conversation.activeTurnId}`)
      }
    }
    const message = getRow(
      txDb, 'SELECT id FROM central_message WHERE id = ? AND conversation_id = ?', input.messageId, conversationId
    )
    if (!message) fail('message_not_found', `message not found in conversation: ${input.messageId}`)
    execWrite(
      txDb,
      `INSERT INTO central_turn (id, conversation_id, message_id, status, runtime, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id, conversationId, input.messageId, status, input.runtime ?? null, ts
    )
    execWrite(txDb, 'UPDATE central_conversation SET active_turn_id = ?, updated_at = ? WHERE id = ?', id, ts, conversationId)
    execWrite(txDb, 'UPDATE central_message SET turn_id = ? WHERE id = ? AND turn_id IS NULL', id, input.messageId)
    return requireTurn(txDb, id)
  })
}
/** Moves a turn; terminal statuses clear the conversation lock and stamp ended_at. */
export function updateTurn(db: Database, input: UpdateTurnInput): Turn {
  const next = validateTurnStatus(input.status)
  const ts = input.now ?? Date.now()
  return writeTx(db, (txDb) => {
    const turn = requireTurn(txDb, input.turnId)
    if (turn.status === next) return turn
    assertTurnTransition(turn.status, next)
    const terminal = !isActiveTurnStatus(next)
    execWrite(
      txDb,
      `UPDATE central_turn SET status = ?, partial_text = ?, usage_json = ?, session_ref = ?,
        error_code = ?, ended_at = ? WHERE id = ?`,
      next,
      input.partialText === undefined ? turn.partialText : input.partialText,
      input.usage === undefined ? JSON.stringify(turn.usage) : JSON.stringify(input.usage),
      input.sessionRef === undefined ? turn.sessionRef : input.sessionRef,
      input.errorCode === undefined ? turn.errorCode : input.errorCode,
      terminal ? ts : null, turn.id
    )
    if (terminal) {
      execWrite(
        txDb,
        'UPDATE central_conversation SET active_turn_id = NULL, updated_at = ? WHERE id = ? AND active_turn_id = ?',
        ts, turn.conversationId, turn.id
      )
    }
    return requireTurn(txDb, turn.id)
  })
}
/** Idempotent cancel: an already-cancelled turn is returned unchanged. */
export function cancelTurn(db: Database, turnId: string, partialText?: string | null, now?: number): Turn {
  const turn = getTurn(db, turnId)
  if (turn?.status === 'cancelled') return turn
  if (!turn || !isActiveTurnStatus(turn.status)) fail('turn_not_active', `turn is not active: ${turnId}`)
  return updateTurn(db, { turnId, status: 'cancelled', partialText, now })
}
/** Appends one replay event with a monotonic seq and a redacted payload. */
export function appendConversationEvent(db: Database, input: AppendConversationEventInput): ConversationEvent {
  const conversationId = validateConversationId(input.conversationId)
  const type = validateEventType(input.type)
  const payload = redactValue(input.payload ?? {}, PERSIST_LIMITS)
  const ts = input.now ?? Date.now()
  return writeTx(db, (txDb) => {
    const conversation = requireConversation(txDb, conversationId)
    const seq = conversation.lastEventSeq + 1
    execWrite(
      txDb,
      `INSERT INTO central_event (conversation_id, seq, type, turn_id, message_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      conversationId, seq, type, input.turnId ?? null, input.messageId ?? null, JSON.stringify(payload), ts
    )
    execWrite(txDb, 'UPDATE central_conversation SET last_event_seq = ?, updated_at = ? WHERE id = ?', seq, ts, conversationId)
    return {
      conversationId, seq, type, turnId: input.turnId ?? null,
      messageId: input.messageId ?? null, payload, createdAt: ts,
    }
  })
}
/** Replay page for SSE: strictly after `afterSeq`, ascending. */
export function listConversationEvents(
  db: Database, conversationId: string, afterSeq = 0, limit?: number
): ConversationEvent[] {
  const id = validateConversationId(conversationId)
  requireConversation(db, id)
  return allRows(
    db,
    'SELECT * FROM central_event WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    id, afterSeq, clampLimit(limit, 200)
  ).map(toEvent)
}
