// Gives a check-in reason back to the queue when the turn that carried it died on the network: `settle` marks a
// reason sent the moment its turn is submitted, so without this a lost turn would also lose the reason for good.
import type { Database } from 'bun:sqlite'
import { execWrite, getRow, tx } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'
import { RECOVER_ACTOR, REQUEUE_EVENT } from './workRecover.model'
import { requeueCount } from './workRecover.victims'

/**
 * Queues `reasonId` again (`sent_at`/`turn_id` back to null; the same row, so the wake is never doubled) unless it
 * already used `limit` attempts. The old sent_at/turn_id stay in the audit event. Returns the attempt number, or null
 * when the limit is reached or the reason is not in the sent state.
 */
export function reopenCheckinReason(db: Database, now: () => number, input: { reasonId: string; taskId: string; limit: number; episode: string }): number | null {
  return tx({ db, now }, () => {
    const used = requeueCount(db, input.reasonId)
    if (used >= input.limit) return null
    const old = getRow(db, 'SELECT sent_at, turn_id FROM central_checkin_reason WHERE id = ? AND sent_at IS NOT NULL', input.reasonId)
    if (!old) return null
    execWrite(db, 'UPDATE central_checkin_reason SET sent_at = NULL, turn_id = NULL WHERE id = ?', input.reasonId)
    appendEvent({ db, now }, { kind: REQUEUE_EVENT, actor: RECOVER_ACTOR, correlationId: input.taskId, payload: { reasonId: input.reasonId, attempt: used + 1, episode: input.episode, sentAt: Number(old.sent_at), turnId: old.turn_id } })
    return used + 1
  })
}
