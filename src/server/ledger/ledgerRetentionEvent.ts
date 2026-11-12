// Retention for the Senses `event` hash chain (data-209-1). Only a PREFIX of the chain is dropped:
// each batch moves `event_chain_base` (v23) to the last dropped row's {seq, hash} and then deletes
// the rows at or below it, in one transaction. The first remaining row's prev_hash is exactly that
// base hash, so verifyChain (which starts from the base) stays ok. The head row is never dropped,
// so the next append and the external anchor keep chaining from a stored row.
//
// Audit rows (hash NULL, from ledgerEvent.ts appendEvent: work.*, central.*, autonomy.*, tool audit) are
// not part of the chain; `pruneAuditEvents` drops them by age and row cap, with or without a project.
//
// Both sweeps keep the newest row of each KEEP_LATEST_KINDS kind forever: those rows are the current
// setting (the classifier switch is read back as "latest event wins") or the last word on it (who halted
// Central and why). A kept chained row may end up at or below the base; verifyChain starts after the
// base, so it is never walked, and it is dropped once a newer row of its kind exists.
import { allRows, execWrite, getRow, tx, type LedgerContext } from './ledgerCore'

/** Chained rows older than this are dropped (keeps the last month of Senses history for replay). */
export const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Hard row cap on the chain (~566 B/row measured, so ~110 MB at the cap). */
export const EVENT_MAX_ROWS = 200_000

const DAY_MS = 24 * 60 * 60 * 1000
/** Audit rows (no hash) older than this are dropped: a quarter of history for "who did what". */
export const AUDIT_EVENT_MAX_AGE_MS = 90 * DAY_MS
/** Hard row cap on audit rows (same order as the chain cap; rows are a few hundred bytes). */
export const AUDIT_EVENT_MAX_ROWS = 200_000

/**
 * Kinds whose newest row is current state, kept whatever its age. `policy.classifier_switch` is read as
 * the switch itself (policy.classifier.ts); halt, control level and breaker rows are the audit of a
 * setting that lives in central_control / central_breaker, kept so the latest change keeps its reason.
 */
export const KEEP_LATEST_KINDS: readonly string[] = ['policy.classifier_switch', 'central.halt', 'central.control', 'central.breaker']
const KEEP_LIST = KEEP_LATEST_KINDS.map((k) => `'${k}'`).join(', ')
/** seq of the newest row of each kept kind (idx_event_kind_seq makes this one index probe per kind). */
const LATEST_KEPT = `(SELECT MAX(seq) FROM event WHERE kind IN (${KEEP_LIST}) GROUP BY kind)`

export interface EventRetentionLimits {
  maxAgeMs: number
  maxRows: number
}

const DEFAULT_LIMITS: EventRetentionLimits = { maxAgeMs: EVENT_MAX_AGE_MS, maxRows: EVENT_MAX_ROWS }

/** seq of the newest chained row the row cap allows dropping (0 = under the cap). */
function countCut(ctx: LedgerContext, maxRows: number): number {
  // ponytail: OFFSET walks maxRows index entries once per sweep; a counter table if the cap grows 10x.
  const row = getRow(ctx.db, 'SELECT seq FROM event WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1 OFFSET ?', maxRows)
  return row ? Number(row['seq']) : 0
}

/**
 * Drops at most `limit` of the oldest chained rows that are past the age or row cap; returns how
 * many. A row stops the prefix as soon as it is still inside both caps (ts is producer-supplied, so
 * it is not guaranteed monotonic in seq; stopping there keeps the drop a strict prefix).
 */
export function pruneEventChain(ctx: LedgerContext, now: number, limit: number, limits: EventRetentionLimits = DEFAULT_LIMITS): number {
  return tx(ctx, () => {
    const head = getRow(ctx.db, 'SELECT seq FROM event WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1')
    if (!head) return 0
    const headSeq = Number(head['seq'])
    const base = Number(getRow(ctx.db, 'SELECT seq FROM event_chain_base WHERE id = 1')?.['seq'] ?? 0)
    const byCount = countCut(ctx, limits.maxRows)
    const ageCut = now - limits.maxAgeMs
    // Kept rows left below the base by earlier passes go once a newer row of their kind exists.
    const stale = execWrite(ctx.db, `DELETE FROM event WHERE hash IS NOT NULL AND seq <= ? AND kind IN (${KEEP_LIST}) AND seq NOT IN ${LATEST_KEPT}`, base)
    const rows = allRows(ctx.db, 'SELECT seq, hash, ts FROM event WHERE hash IS NOT NULL AND seq > ? AND seq < ? ORDER BY seq ASC LIMIT ?', base, headSeq, limit)
    let last: { seq: number; hash: string } | null = null
    for (const r of rows) {
      const seq = Number(r['seq'])
      if (seq > byCount && Number(r['ts']) >= ageCut) break
      last = { seq, hash: String(r['hash']) }
    }
    if (!last) return stale
    // Base first: the v23 delete trigger only admits rows at or below the stored base.
    execWrite(ctx.db, `INSERT INTO event_chain_base (id, seq, hash, pruned, updated_at) VALUES (1, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, updated_at = excluded.updated_at`, last.seq, last.hash, now)
    const n = execWrite(ctx.db, `DELETE FROM event WHERE hash IS NOT NULL AND seq > ? AND seq <= ? AND seq NOT IN ${LATEST_KEPT}`, base, last.seq)
    execWrite(ctx.db, 'UPDATE event_chain_base SET pruned = pruned + ? WHERE id = 1', n + stale)
    return n + stale
  })
}

/**
 * Drops at most `limit` audit rows (hash NULL) that are past AUDIT_EVENT_MAX_AGE_MS or the row cap, except
 * the newest row of each kept kind and the timeline of a work task that still exists (workDuties.ts and
 * the task timeline read `work.*` rows by correlation id).
 */
export function pruneAuditEvents(ctx: LedgerContext, now: number, limit: number): number {
  // ponytail: no index on hash, so the cap probe walks the newest rows once per batch; a partial index if it shows up.
  const cut = getRow(ctx.db, 'SELECT seq FROM event WHERE hash IS NULL ORDER BY seq DESC LIMIT 1 OFFSET ?', AUDIT_EVENT_MAX_ROWS)
  return execWrite(ctx.db, `DELETE FROM event WHERE rowid IN (SELECT e.seq FROM event e WHERE e.hash IS NULL AND (e.ts < ? OR e.seq <= ?)
    AND e.seq NOT IN ${LATEST_KEPT}
    AND NOT (e.correlation_id IS NOT NULL AND EXISTS (SELECT 1 FROM central_task t WHERE t.id = e.correlation_id)) LIMIT ?)`,
  now - AUDIT_EVENT_MAX_AGE_MS, cut ? Number(cut['seq']) : 0, limit)
}
