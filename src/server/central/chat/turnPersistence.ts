// Persistence + finalization for chat turns (RND/08 §7, RND/13 §4 C1).
// Owns every SQL touch outside the conversation store: idempotency lookup, event
// append/publish, assistant-message finalization, and history reads. The service
// keeps orchestration/lock logic only.
import type { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { projectRepository } from '../../ledger/ledgerEntity'
import {
  type CentralEventType, conversationIdForScope, isActiveTurnStatus,
  scopeFromConversationId, type MessagePart, type ToolCardState, type TurnStatus,
} from '../conversationModel'
import { PERSIST_LIMITS, redactValue } from '../../redactSecrets'
import { brokerSecretValues, maskValue } from '../runtime/runtimeEvents'
import {
  appendConversationEvent, appendMessage, getConversation, getOrCreateConversation, getTurn,
  updateTurn, type Conversation, type Message, type Turn,
} from '../conversationStore'
import type { ConversationPage, ConversationSummary } from '../centralTypes'
import type { RuntimeResult } from '../runtime/centralRuntime'
import { lookupWorkspace } from '../workspaceLookup'
import { CentralChatError } from './chatErrors'
import type { StreamHub } from './streamHub'
import { currentPartState, registerApprovalStream } from './approvalPublish'
import type { RunState } from './turnEvents'

export interface StoredMessage {
  id: string; conversationId: string; seq: number; role: string
  parts: MessagePart[]; clientMessageId: string | null; turnId: string | null
  state: string; createdAt: number
}

export interface MessagePage {
  items: StoredMessage[]
  nextBefore: number | null
}

export const DEFAULT_MESSAGE_LIMIT = 50
export const MAX_MESSAGE_LIMIT = 200

function asMessage(row: Record<string, unknown>): StoredMessage {
  const optional = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
  return {
    id: String(row['id']), conversationId: String(row['conversation_id']), seq: Number(row['seq']),
    role: String(row['role']), parts: JSON.parse(String(row['parts_json'])) as MessagePart[],
    clientMessageId: optional(row['client_message_id']), turnId: optional(row['turn_id']),
    state: String(row['state']), createdAt: Number(row['created_at']),
  }
}

/** Appends one event, then publishes the persisted row so the stream never leads the DB. */
export function recordEvent(
  db: Database, stream: StreamHub, conversationId: string, type: CentralEventType,
  payload: unknown, turnId: string | null, messageId: string | null, now: () => number
): void {
  // A hub that carries turns also carries the approval frames of its conversations.
  registerApprovalStream(db, stream, now)
  const event = appendConversationEvent(db, { conversationId, type, turnId, messageId, payload, now: now() })
  stream.publish(conversationId, event)
}

// Project ids that are workspace ids (UI bind, Telegram) resolve through the store registered at boot.
export { registerWorkspaceLookup, type WorkspaceLookup } from '../workspaceLookup'

/**
 * Ledger project id for a project id or a workspace id. Callers (UI bind, Telegram) pass the
 * workspace id, and nothing else creates ledger rows for workspaces, so the first turn creates
 * it (id = workspace id). Synchronous SQLite, so a second call sees the row: never doubled.
 */
function ensureLedgerProjectId(db: Database, id: string): string {
  if (getRow(db, 'SELECT 1 AS one FROM project WHERE id = ?', id) !== null) return id
  const linked = getRow(db, 'SELECT id FROM project WHERE workspace_id = ?', id)
  if (linked !== null) return String(linked['id'])
  const workspace = lookupWorkspace(id)
  if (workspace === null) throw new CentralChatError('project_not_found', `project not found: ${id}`, 404)
  projectRepository({ db, now: Date.now }).createProject({
    id, workspaceId: id, name: workspace.name, path: workspace.cwd || homedir(),
  })
  return id
}

/**
 * Canonical ids auto-create on first use. A project conversation is only created
 * when the project row exists (or its workspace does); otherwise a typed 404, not an empty chat.
 */
export function resolveOrCreateConversation(db: Database, rawId: string): Conversation {
  const scope = scopeFromConversationId(rawId)
  const existing = getConversation(db, conversationIdForScope(scope))
  if (existing) return existing
  if (scope.kind === 'global' && scope.chatId === undefined) return getOrCreateConversation(db, 'global')
  // Extra chats exist only through `createChatConversation`: a made-up id is a 404, never a new row.
  if (scope.kind === 'global') throw new CentralChatError('conversation_not_found', `conversation not found: ${rawId}`, 404)
  const projectId = ensureLedgerProjectId(db, scope.projectId)
  return getOrCreateConversation(db, `project:${projectId}`)
}

export function findByClientMessageId(
  db: Database, conversationId: string, clientMessageId: string
): StoredMessage | null {
  const row = getRow(
    db, 'SELECT * FROM central_message WHERE conversation_id = ? AND client_message_id = ?',
    conversationId, clientMessageId
  )
  return row ? asMessage(row) : null
}

export function busyError(conversation: Conversation, fallbackTurnId?: string | null): CentralChatError {
  const activeTurnId = conversation.activeTurnId ?? fallbackTurnId ?? null
  const error = new CentralChatError('conversation_busy', `conversation ${conversation.id} has an active turn`, 409)
  ;(error as CentralChatError & { activeTurnId?: string | null }).activeTurnId = activeTurnId
  return error
}

export function appendAssistantMessage(
  db: Database, conversationId: string, turnId: string, now: () => number
): Message {
  return appendMessage(db, {
    conversationId, role: 'assistant', parts: [], turnId, state: 'streaming', now: now(),
  }).message
}

/** Reason shown on a failed reply when the runtime gave none (it ended with an error code only). */
const FAILED_FALLBACK = 'The central agent stopped with an error.'

function assistantParts(
  state: RunState, text: string, failure: { code: string; message: string } | null, cardState: (approvalId: string) => ToolCardState
): MessagePart[] {
  const parts: MessagePart[] = state.notices.map((notice) => ({ type: 'notice' as const, text: notice }))
  if (text !== '') parts.push({ type: 'text', text })
  for (const tool of state.tools.values()) {
    parts.push({
      type: 'tool', toolCallId: tool.toolCallId, name: tool.name, state: tool.state, risk: 'R0',
      ...(tool.args === undefined ? {} : { args: tool.args }),
      ...(tool.result === undefined ? {} : { result: tool.result }),
    })
    // The chat's approval card, in the state the ledger has now (it may be decided before the turn ends).
    if (tool.approvalId) parts.push({ type: 'approval', approvalId: tool.approvalId, state: cardState(tool.approvalId) })
  }
  if (failure) parts.push({ type: 'error', ...failure })
  return parts
}

/** Writes the assistant parts/state, closes the turn, and emits `turn.status` + `done`. */
export function finalizeTurn(
  db: Database, stream: StreamHub, conversationId: string, turnId: string, assistantId: string,
  state: RunState, result: RuntimeResult, now: () => number
): Turn {
  const current = getTurn(db, turnId)
  if (!current) throw new CentralChatError('turn_not_found', `turn not found: ${turnId}`, 404)
  if (!isActiveTurnStatus(current.status)) return current
  const status: TurnStatus = result.outcome === 'success'
    ? 'succeeded'
    : result.outcome === 'cancelled' ? 'cancelled' : 'failed'
  const text = result.text === '' ? state.text : result.text
  const failure = status === 'failed'
    ? state.failure ?? { code: result.errorCode ?? 'runtime_error', message: FAILED_FALLBACK }
    : null
  execWrite(
    db, 'UPDATE central_message SET parts_json = ?, state = ? WHERE id = ?',
    // Masked again as a whole: a broker value split across two text deltas only reassembles here.
    JSON.stringify(redactValue(maskValue(assistantParts(state, text, failure, (id) => currentPartState(db, id, now)), brokerSecretValues()), PERSIST_LIMITS)),
    status === 'succeeded' ? 'complete' : status, assistantId
  )
  const turn = updateTurn(db, {
    turnId, status,
    partialText: status === 'succeeded' ? null : text,
    usage: result.usage ?? state.usage,
    sessionRef: result.sessionRef ?? current.sessionRef,
    errorCode: result.errorCode ?? null,
    now: now(),
  })
  recordEvent(db, stream, conversationId, 'turn.status', {
    status, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }), usage: turn.usage,
  }, turnId, assistantId, now)
  recordEvent(db, stream, conversationId, 'done', {
    status, outcome: result.outcome, usage: turn.usage,
  }, turnId, assistantId, now)
  return turn
}

export const DEFAULT_CONVERSATION_LIMIT = 50
export const MAX_CONVERSATION_LIMIT = 200
const TITLE_CHARS = 80

/** A fresh global chat ("New chat"): its own id, so its first turn has no session to resume. */
export function createChatConversation(db: Database, now?: number): ConversationSummary {
  const conversation = getOrCreateConversation(db, `chat:${randomUUID()}`, now)
  return { ...conversation, title: null, turnCount: 0 }
}

/** First line of the first human message, trimmed for the list; null until one is sent. */
function titleOf(partsJson: unknown): string | null {
  if (typeof partsJson !== 'string') return null
  const parts = JSON.parse(partsJson) as MessagePart[]
  const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join(' ').trim().split('\n')[0]?.trim() ?? ''
  if (text === '') return null
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text
}

/** Every conversation (global, extra chats, projects), newest first, one page at a time. */
export function listConversationSummaries(
  db: Database, options: { limit?: number; offset?: number; now?: number } = {}
): ConversationPage {
  const limit = options.limit ?? DEFAULT_CONVERSATION_LIMIT
  const offset = options.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONVERSATION_LIMIT) {
    throw new CentralChatError('invalid_limit', `limit must be 1..${MAX_CONVERSATION_LIMIT}`, 400)
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CentralChatError('invalid_cursor', 'offset must be a non-negative integer', 400)
  }
  getOrCreateConversation(db, 'global', options.now)
  const rows = allRows(
    db,
    `SELECT c.*,
       (SELECT m.parts_json FROM central_message m WHERE m.conversation_id = c.id AND m.role = 'human'
        ORDER BY m.seq ASC LIMIT 1) AS first_human,
       (SELECT COUNT(*) FROM central_turn t WHERE t.conversation_id = c.id) AS turn_count
     FROM central_conversation c ORDER BY c.updated_at DESC, c.id ASC LIMIT ? OFFSET ?`,
    limit + 1, offset
  )
  const optional = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
  const items = rows.slice(0, limit).map((row) => ({
    id: String(row['id']), scope: String(row['scope']), projectId: optional(row['project_id']),
    activeTurnId: optional(row['active_turn_id']),
    lastEventSeq: Number(row['last_event_seq']), lastMessageSeq: Number(row['last_message_seq']),
    createdAt: Number(row['created_at']), updatedAt: Number(row['updated_at']),
    title: titleOf(row['first_human']), turnCount: Number(row['turn_count']),
  }))
  return { items, nextOffset: rows.length > limit ? offset + limit : null }
}

/** One page of history, ascending; `nextBefore` pages backwards (seq < before). */
export function listMessages(
  db: Database, conversationId: string, options: { limit?: number; before?: number } = {}
): MessagePage {
  scopeFromConversationId(conversationId)
  if (!getConversation(db, conversationId)) {
    throw new CentralChatError('conversation_not_found', `conversation not found: ${conversationId}`, 404)
  }
  const limit = options.limit ?? DEFAULT_MESSAGE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIMIT) {
    throw new CentralChatError('invalid_limit', `limit must be 1..${MAX_MESSAGE_LIMIT}`, 400)
  }
  const before = options.before
  if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
    throw new CentralChatError('invalid_cursor', 'before must be a positive message seq', 400)
  }
  const rows = before === undefined
    ? allRows(db, `SELECT * FROM central_message WHERE conversation_id = ?
        ORDER BY seq DESC LIMIT ?`, conversationId, limit + 1)
    : allRows(db, `SELECT * FROM central_message WHERE conversation_id = ? AND seq < ?
        ORDER BY seq DESC LIMIT ?`, conversationId, before, limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).map(asMessage).reverse()
  return { items: page, nextBefore: hasMore && page.length > 0 ? page[0]!.seq : null }
}
