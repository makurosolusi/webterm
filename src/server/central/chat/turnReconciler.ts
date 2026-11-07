// Boot-time turn reconciliation (RND/28 B2): a `queued`/`running`/`awaiting_approval` turn with no
// live process is a zombie that would lock its conversation forever. Pure over `(db, now)` so the
// integrator (WS-19) can call it at boot; `liveTurnIds` protects turns a running service owns.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite } from '../../ledger/ledgerCore'
import { PERSIST_LIMITS, redactValue } from '../../redactSecrets'
import { appendConversationEvent, updateTurn } from '../conversationStore'
import type { MessagePart } from '../conversationModel'

export const INTERRUPTED_CODE = 'interrupted'
/** Reason on a reply cut off by a server restart, persisted as its `error` part. */
export const INTERRUPTED_MESSAGE = 'The server restarted before this reply finished.'

export interface ReconcileOptions {
  /** Turns that still have a live process; never touched. */
  liveTurnIds?: ReadonlySet<string>
}

export interface ReconcileResult {
  /** Turns moved to `failed`/`interrupted`. */
  turnIds: string[]
  /** Conversations whose dangling `active_turn_id` was cleared without a turn to fail. */
  clearedConversations: number
}

const ACTIVE_SQL = `SELECT id, conversation_id FROM central_turn
  WHERE status IN ('queued', 'running', 'awaiting_approval') ORDER BY started_at ASC, rowid ASC`

/** Text streamed so far, rebuilt from the replay log (the turn row has none while running). */
function streamedText(db: Database, conversationId: string, turnId: string): string {
  const rows = allRows(
    db,
    `SELECT payload_json FROM central_event WHERE conversation_id = ? AND turn_id = ?
     AND type = 'part.delta' ORDER BY seq ASC`,
    conversationId, turnId
  )
  return rows.map((row) => {
    const payload = JSON.parse(String(row['payload_json'])) as { delta?: unknown }
    return typeof payload.delta === 'string' ? payload.delta : ''
  }).join('')
}

/** Fails every orphaned active turn as `interrupted`, keeping its partial text, and frees locks. */
export function reconcileTurns(db: Database, now: number, options: ReconcileOptions = {}): ReconcileResult {
  const turnIds: string[] = []
  for (const row of allRows(db, ACTIVE_SQL)) {
    const turnId = String(row['id'])
    if (options.liveTurnIds?.has(turnId)) continue
    const conversationId = String(row['conversation_id'])
    const text = streamedText(db, conversationId, turnId)
    const turn = updateTurn(db, {
      turnId, status: 'failed', errorCode: INTERRUPTED_CODE, partialText: text === '' ? null : text, now,
    })
    const parts: MessagePart[] = text === '' ? [] : [{ type: 'text', text }]
    parts.push({ type: 'error', code: INTERRUPTED_CODE, message: INTERRUPTED_MESSAGE })
    execWrite(
      db, `UPDATE central_message SET parts_json = ?, state = 'failed' WHERE turn_id = ? AND role = 'assistant'`,
      JSON.stringify(redactValue(parts, PERSIST_LIMITS)), turnId
    )
    appendConversationEvent(db, {
      conversationId, type: 'turn.status', turnId, now,
      payload: { status: 'failed', errorCode: INTERRUPTED_CODE, usage: turn.usage },
    })
    appendConversationEvent(db, {
      conversationId, type: 'done', turnId, now,
      payload: { status: 'failed', outcome: 'error', usage: turn.usage },
    })
    turnIds.push(turnId)
  }
  // Every non-live active turn is failed above, so a pointer still set here is dangling.
  let cleared = 0
  for (const row of allRows(db, 'SELECT id, active_turn_id FROM central_conversation WHERE active_turn_id IS NOT NULL')) {
    const activeId = String(row['active_turn_id'])
    if (options.liveTurnIds?.has(activeId)) continue
    execWrite(db, 'UPDATE central_conversation SET active_turn_id = NULL, updated_at = ? WHERE id = ?', now, String(row['id']))
    cleared += 1
  }
  return { turnIds, clearedConversations: cleared }
}
