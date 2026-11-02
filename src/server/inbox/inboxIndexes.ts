// Supporting indexes for the state-first inbox projection.
//
// `ledgerSchema.ts` owns the ledger's own indexes and is not the right home for a P4 read model, so
// the DDL lives beside the projection. Applying it is idempotent and DDL-only (CREATE INDEX IF NOT
// EXISTS never touches rows); `buildInbox` itself stays a pure SELECT.
//
// The `needs_you` branch filters `approval(status, expires_at, project_id)` and orders by
// `created_at`, and the badge polls it from two places every 30 s. Without an index that is a full
// table scan per open client.
import type { Database } from 'bun:sqlite'
import { createLogger } from '../logs'

const log = createLogger('inbox')

export const INBOX_INDEXES: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_approval_status_expires ON approval(status, expires_at, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_approval_project_status ON approval(project_id, status, expires_at)',
]

/** One attempt per connection: a read-only DB must not turn every request into a retry + log. */
const attempted = new WeakSet<object>()

/**
 * Best effort. A read-only database (or a missing approval table) must not fail the inbox, so the
 * projection keeps working unindexed and the reason is logged once per connection.
 */
export function ensureInboxIndexes(db: Database): void {
  const key = db as unknown as object
  if (attempted.has(key)) return
  attempted.add(key)
  try {
    for (const sql of INBOX_INDEXES) db.exec(sql)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('inbox.indexes.unavailable', `inbox indexes unavailable (projection still works unindexed): ${reason}`)
  }
}
