// Persistence + finalization for chat turns (RND/08 §7, RND/13 §4 C1).
// Owns every SQL touch outside the conversation store: idempotency lookup, event
// append/publish, assistant-message finalization, and history reads. The service
// keeps orchestration/lock logic only.
import type { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { projectRepository } from '../../ledger/ledgerEntity'
import {
  type CentralEventType, conversationIdForScope, isActiveTurnStatus,
  scopeFromConversationId, type MessagePart, type TurnStatus,
} from '../conversationModel'
import { PERSIST_LIMITS, redactValue } from '../../redactSecrets'
import {
  appendConversationEvent, appendMessage, getConversation, getOrCreateConversation, getTurn,
  updateTurn, type Conversation, type Message, type Turn,
} from '../conversationStore'
import type { ConversationSummary } from '../centralTypes'
import type { RuntimeResult } from '../runtime/centralRuntime'
import { CentralChatError } from './chatErrors'
import type { StreamHub } from './streamHub'
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
  const event = appendConversationEvent(db, { conversationId, type, turnId, messageId, payload, now: now() })
  stream.publish(conversationId, event)
}

/** Workspace store lookup (webterm.db, a different file from the ledger); registered at boot. */
export type WorkspaceLookup = (id: string) => { name: string; cwd?: string } | null
let lookupWorkspace: WorkspaceLookup = () => null

/** Lets project ids that are workspace ids (UI bind, Telegram) resolve; returns the unregister. */
export function registerWorkspaceLookup(lookup: WorkspaceLookup): () => void {
  lookupWorkspace = lookup
  return () => { lookupWorkspace = () => null }
}

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
  if (scope.kind === 'global') return getOrCreateConversation(db, 'global')
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

function assistantParts(state: RunState, text: string): MessagePart[] {
  const parts: MessagePart[] = []
  if (text !== '') parts.push({ type: 'text', text })
  for (const tool of state.tools.values()) {
    parts.push({
      type: 'tool', toolCallId: tool.toolCallId, name: tool.name, state: tool.state, risk: 'R0',
      ...(tool.args === undefined ? {} : { args: tool.args }),
      ...(tool.result === undefined ? {} : { result: tool.result }),
    })
  }
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
  execWrite(
    db, 'UPDATE central_message SET parts_json = ?, state = ? WHERE id = ?',
    JSON.stringify(redactValue(assistantParts(state, text), PERSIST_LIMITS)),
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

/** Global conversation plus every existing project conversation, global first. */
export function listConversationSummaries(db: Database, now?: number): ConversationSummary[] {
  getOrCreateConversation(db, 'global', now)
  return allRows(
    db,
    `SELECT * FROM central_conversation
     ORDER BY CASE WHEN id = 'central:global' THEN 0 ELSE 1 END, updated_at DESC, id ASC`
  ).map((row) => ({
    id: String(row['id']), scope: String(row['scope']),
    projectId: row['project_id'] === null || row['project_id'] === undefined ? null : String(row['project_id']),
    activeTurnId: row['active_turn_id'] === null || row['active_turn_id'] === undefined
      ? null : String(row['active_turn_id']),
    lastEventSeq: Number(row['last_event_seq']), lastMessageSeq: Number(row['last_message_seq']),
    updatedAt: Number(row['updated_at']),
  }))
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
