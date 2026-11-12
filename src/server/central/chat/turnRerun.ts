// Regenerate and Edit of the Central chat's last human message (Claude.ai / ChatGPT). Deliberate scope
// limit: only the LAST human message can be re-run; there is no branch tree to switch between. The old
// human message and its reply are marked `superseded` (kept for audit, hidden from the thread API and from
// the model's context; they age out under the normal per-conversation caps) and a new human message goes
// through the normal `submit` path.
//
// Session: the Claude session already holds the old reply, and resuming an earlier turn's session id brings
// it back too (Claude keeps one session id across resumes), so there is nothing clean to roll back to. The
// re-run therefore starts a fresh session seeded from the visible history, the same path as a `/model`
// switch, and `freshSessionPending` keeps later turns fresh until one succeeds. Checkpoints that summarised
// the superseded rows are dropped: they are a derived cache of the history, and a seed would replay them.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, type Row } from '../../ledger/ledgerCore'
import { normalizeClientMessageId, validateMessageText, type MessagePart } from '../conversationModel'
import { writeTx } from '../writeTx'
import { type CentralAttachments, parseAttachments } from './chatAttachments'
import { CentralChatError } from './chatErrors'
import type { StreamHub } from './streamHub'
import {
  busyError, findByClientMessageId, recordEvent, resolveOrCreateConversation, type StoredMessage,
} from './turnPersistence'

export type RerunMode = 'regenerate' | 'edit'

export interface RerunInput {
  conversationId: string
  mode: RerunMode
  /** Edit: the human message. Regenerate: that message or its reply. */
  messageId: unknown
  clientMessageId: unknown
  /** Edit only: the new text. */
  text?: unknown
}

export interface RerunSubmit { conversationId: string; clientMessageId: string; text: string; attachments: CentralAttachments }

/** Newest visible human message, unless an automatic (system) turn came after it. */
function lastHuman(db: Database, conversationId: string): Row | null {
  const row = getRow(db, `SELECT * FROM central_message WHERE conversation_id = ? AND state != 'superseded'
    AND (role = 'human' OR (role = 'system' AND turn_id IS NOT NULL)) ORDER BY seq DESC LIMIT 1`, conversationId)
  return row && row['role'] === 'human' ? row : null
}

/** The attachments of a stored message, resent by reference (as Retry does). */
function storedAttachments(conversationId: string, parts: MessagePart[]): CentralAttachments {
  const images = parts.flatMap((p) => (p.type === 'image' ? [{ ref: p.ref }] : []))
  const files = parts.flatMap((p) => (p.type === 'file' ? [{ name: p.name, ref: p.ref }] : []))
  const parsed = parseAttachments({ images, files }, conversationId)
  if ('reason' in parsed) throw new CentralChatError('invalid_attachment', parsed.reason, 400)
  return parsed
}

/**
 * Validates a Regenerate/Edit, supersedes the old exchange and answers what to submit; a repeated
 * `clientMessageId` answers the stored message to replay instead (nothing is superseded twice).
 */
export function prepareRerun(
  db: Database, stream: StreamHub, input: RerunInput, runtimeKind: string,
  activeTurn: (conversationId: string) => string | undefined, now: () => number,
): RerunSubmit | { replay: StoredMessage } {
  const conversation = resolveOrCreateConversation(db, input.conversationId)
  const clientMessageId = normalizeClientMessageId(input.clientMessageId)
  if (clientMessageId === null) throw new CentralChatError('invalid_message', 'clientMessageId is required', 400)
  const existing = findByClientMessageId(db, conversation.id, clientMessageId)
  if (existing) return { replay: existing }
  const active = activeTurn(conversation.id)
  if (active !== undefined || conversation.activeTurnId !== null) throw busyError(conversation, active)
  if (typeof input.messageId !== 'string' || input.messageId === '') throw new CentralChatError('invalid_body', 'messageId is required', 400)
  const target = getRow(db, 'SELECT id, role, turn_id FROM central_message WHERE id = ? AND conversation_id = ?', input.messageId, conversation.id)
  if (!target) throw new CentralChatError('message_not_found', `message not found: ${input.messageId}`, 404)
  const human = lastHuman(db, conversation.id)
  const turnId = human?.['turn_id'] == null ? null : String(human['turn_id'])
  const isLast = human !== null && (target['id'] === human['id'] ||
    (input.mode === 'regenerate' && target['role'] === 'assistant' && turnId !== null && target['turn_id'] === turnId))
  if (!human || !isLast) throw new CentralChatError('not_last_message', 'only your last message can be regenerated or edited', 400)

  const parts = JSON.parse(String(human['parts_json'])) as MessagePart[]
  const attachments = storedAttachments(conversation.id, parts)
  if (attachments.images.length && runtimeKind !== 'claude') {
    throw new CentralChatError('images_unsupported', 'Images need the Claude runtime; this Central runs on another one.', 400)
  }
  const attached = attachments.images.length > 0 || attachments.files.length > 0
  const text = input.mode === 'regenerate'
    ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    // Same rule as a send: blank text is allowed only next to attachments.
    : attached && typeof input.text === 'string' && !input.text.trim() ? '' : validateMessageText(input.text)

  const humanId = String(human['id'])
  const ids = writeTx(db, (tx) => {
    const rows = allRows(tx, `SELECT id FROM central_message WHERE conversation_id = ? AND state != 'superseded'
      AND (id = ? OR (turn_id IS NOT NULL AND turn_id = ?))`, conversation.id, humanId, turnId ?? '').map((r) => String(r['id']))
    execWrite(tx, `UPDATE central_message SET state = 'superseded' WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows)
    execWrite(tx, `DELETE FROM central_checkpoint WHERE conversation_id = ? AND to_message_id IN
      (SELECT id FROM central_message WHERE conversation_id = ? AND seq >= ?)`, conversation.id, conversation.id, Number(human['seq']))
    return rows
  })
  // Audit + live thread update: the client drops these rows; the new message follows as `message.created`.
  recordEvent(db, stream, conversation.id, 'message.superseded', { messageIds: ids, reason: input.mode }, turnId, humanId, now)
  return { conversationId: conversation.id, clientMessageId, text, attachments }
}

/** True while a superseded exchange is newer than the last good turn: the next turn opens a fresh session. */
export function freshSessionPending(db: Database, conversationId: string): boolean {
  const row = getRow(db, `SELECT
    (SELECT MAX(seq) FROM central_message WHERE conversation_id = ? AND state = 'superseded') AS s,
    (SELECT MAX(m.seq) FROM central_turn t JOIN central_message m ON m.id = t.message_id
      WHERE t.conversation_id = ? AND t.status = 'succeeded' AND m.state != 'superseded') AS ok`, conversationId, conversationId)
  return row?.['s'] != null && (row['ok'] == null || Number(row['s']) > Number(row['ok']))
}
