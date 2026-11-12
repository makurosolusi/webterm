// Retention for the Central chat (`central_message`, `central_turn`): automatic notices age out, the
// conversation itself is capped by count, and a turn's context trace is blanked once it is old. Each
// function deletes or blanks at most `limit` rows and returns how many it changed.
//
// A message is never removed while something still depends on it:
//  - a message of a turn that is still running (its reply streams into it);
//  - the newest `/model` choice of a conversation (conversationModelChoice.ts reads it as the setting);
//  - a notice whose subject still waits for the user: an open inbox item (`notice:inbox:<id>`) or a
//    work task that is not done or cancelled (`notice:work:<task>:…`, `notice:escalate:<task>:…`).
import { TURN_STATUSES, isActiveTurnStatus } from '../central/conversationModel'
import { allRows, execWrite, getRow, type LedgerContext } from './ledgerCore'

const DAY_MS = 24 * 60 * 60 * 1000
/** Automatic notices (system messages outside a turn) are kept this long. */
export const NOTICE_RETENTION_MS = 30 * DAY_MS
/**
 * Newest messages kept per conversation. The model only ever sees the last 20 (contextPort HISTORY_LIMIT)
 * and the UI pages history, so this is pure scroll-back: about a year of heavy daily use (~15 messages a
 * day), at a few KB per row well under 50 MB per conversation. One conversation exists per scope.
 */
export const CONVERSATION_MAX_MESSAGES = 5000
/** Newest turns kept per conversation: a turn is one prompt plus its reply, so half the message cap. */
export const CONVERSATION_MAX_TURNS = CONVERSATION_MAX_MESSAGES / 2
/** A turn's `context_json` (what it was given; the "why did Central say that" view) is blanked after this. */
export const TURN_CONTEXT_RETENTION_MS = 30 * DAY_MS

const TERMINAL_TURNS = TURN_STATUSES.filter((s) => !isActiveTurnStatus(s)).map((s) => `'${s}'`).join(', ')
const OPEN_TASK = `t.status NOT IN ('done', 'cancelled')`
const taskIdAfter = (prefix: string): string =>
  `substr(m.client_message_id, ${prefix.length + 1}, instr(substr(m.client_message_id, ${prefix.length + 1}), ':') - 1)`

/** Rows of `central_message m` that must stay whatever their age or rank. */
const PROTECTED_MESSAGE = `(
  EXISTS (SELECT 1 FROM central_turn t WHERE t.id = m.turn_id AND t.status NOT IN (${TERMINAL_TURNS}))
  OR (m.role = 'system' AND substr(m.client_message_id, 1, 6) = 'model:' AND m.seq = (SELECT MAX(x.seq) FROM central_message x
    WHERE x.conversation_id = m.conversation_id AND x.role = 'system' AND substr(x.client_message_id, 1, 6) = 'model:'))
  OR (substr(m.client_message_id, 1, 13) = 'notice:inbox:' AND EXISTS (SELECT 1 FROM inbox_item i
    WHERE i.id = substr(m.client_message_id, 14) AND i.status = 'open'))
  OR (substr(m.client_message_id, 1, 12) = 'notice:work:' AND EXISTS (SELECT 1 FROM central_task t
    WHERE t.id = ${taskIdAfter('notice:work:')} AND ${OPEN_TASK}))
  OR (substr(m.client_message_id, 1, 16) = 'notice:escalate:' AND EXISTS (SELECT 1 FROM central_task t
    WHERE t.id = ${taskIdAfter('notice:escalate:')} AND ${OPEN_TASK}))
)`

const conversations = (ctx: LedgerContext, table: string): string[] =>
  allRows(ctx.db, `SELECT DISTINCT conversation_id AS c FROM ${table}`).map((r) => String(r['c']))

/** System notices (outside any turn) older than NOTICE_RETENTION_MS, then everything past the per-conversation cap. */
export function sweepMessages(ctx: LedgerContext, now: number, limit: number): number {
  let n = execWrite(ctx.db, `DELETE FROM central_message WHERE rowid IN (SELECT m.rowid FROM central_message m
    WHERE m.role = 'system' AND m.turn_id IS NULL AND m.created_at < ? AND NOT ${PROTECTED_MESSAGE} LIMIT ?)`, now - NOTICE_RETENTION_MS, limit)
  for (const id of conversations(ctx, 'central_message')) {
    if (n >= limit) break
    const cut = getRow(ctx.db, 'SELECT seq FROM central_message WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?', id, CONVERSATION_MAX_MESSAGES - 1)
    if (!cut) continue
    n += execWrite(ctx.db, `DELETE FROM central_message WHERE rowid IN (SELECT m.rowid FROM central_message m
      WHERE m.conversation_id = ? AND m.seq < ? AND NOT ${PROTECTED_MESSAGE} LIMIT ?)`, id, Number(cut['seq']), limit - n)
  }
  return n
}

/** Blanks old settled turns' context traces, then drops settled turns past the per-conversation cap. */
export function sweepTurns(ctx: LedgerContext, now: number, limit: number): number {
  let n = execWrite(ctx.db, `UPDATE central_turn SET context_json = NULL WHERE rowid IN (SELECT rowid FROM central_turn
    WHERE context_json IS NOT NULL AND status IN (${TERMINAL_TURNS}) AND started_at < ? LIMIT ?)`, now - TURN_CONTEXT_RETENTION_MS, limit)
  for (const id of conversations(ctx, 'central_turn')) {
    if (n >= limit) break
    const cut = getRow(ctx.db, 'SELECT started_at FROM central_turn WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1 OFFSET ?', id, CONVERSATION_MAX_TURNS - 1)
    if (!cut) continue
    n += execWrite(ctx.db, `DELETE FROM central_turn WHERE rowid IN (SELECT t.rowid FROM central_turn t
      WHERE t.conversation_id = ? AND t.started_at < ? AND t.status IN (${TERMINAL_TURNS})
        AND NOT EXISTS (SELECT 1 FROM central_conversation c WHERE c.active_turn_id = t.id) LIMIT ?)`, id, Number(cut['started_at']), limit - n)
  }
  return n
}
