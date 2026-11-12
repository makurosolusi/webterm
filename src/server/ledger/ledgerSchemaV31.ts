/**
 * v31: `central_checkin_reason.not_before` (Central's open duties).
 *
 * A failed delegation wakes Central, but only after the turn that saw the failed send has had its chance to fix it:
 * the reason is queued with a time before which it is not delivered. NULL keeps every existing row deliverable as before.
 * Additive and idempotent (guarded ALTER); nothing to backfill.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV31(db: Database): void {
  addColumnIfMissing(db, 'central_checkin_reason', 'not_before', 'INTEGER')
}
