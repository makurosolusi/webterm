/**
 * v39: central_conversation.mode + skill_target (a Central chat locked to a role, e.g. the Central skill author).
 *
 * Both nullable: NULL = an ordinary Central chat, so every existing row keeps today's behaviour and there is
 * nothing to backfill. The mode is validated in code (chat/conversationMode.ts), not by a CHECK, so adding a
 * mode later needs no table rebuild. Idempotent: the ALTER is guarded.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV39(db: Database): void {
  addColumnIfMissing(db, 'central_conversation', 'mode', 'TEXT')
  addColumnIfMissing(db, 'central_conversation', 'skill_target', 'TEXT')
}
