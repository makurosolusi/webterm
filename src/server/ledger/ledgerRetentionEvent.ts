// Retention for the Senses `event` hash chain (data-209-1). Only a PREFIX of the chain is dropped:
// each batch moves `event_chain_base` (v23) to the last dropped row's {seq, hash} and then deletes
// the rows at or below it, in one transaction. The first remaining row's prev_hash is exactly that
// base hash, so verifyChain (which starts from the base) stays ok. The head row is never dropped,
// so the next append and the external anchor keep chaining from a stored row.
//
// Legacy rows (hash NULL, project audit rows from ledgerEvent.ts) are not part of the chain and are
// left to the project cascade.
import { allRows, execWrite, getRow, tx, type LedgerContext } from './ledgerCore'

/** Chained rows older than this are dropped (keeps the last month of Senses history for replay). */
export const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Hard row cap on the chain (~566 B/row measured, so ~110 MB at the cap). */
export const EVENT_MAX_ROWS = 200_000

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
    const rows = allRows(ctx.db, 'SELECT seq, hash, ts FROM event WHERE hash IS NOT NULL AND seq > ? AND seq < ? ORDER BY seq ASC LIMIT ?', base, headSeq, limit)
    let last: { seq: number; hash: string } | null = null
    let n = 0
    for (const r of rows) {
      const seq = Number(r['seq'])
      if (seq > byCount && Number(r['ts']) >= ageCut) break
      last = { seq, hash: String(r['hash']) }
      n += 1
    }
    if (!last) return 0
    // Base first: the v23 delete trigger only admits rows at or below the stored base.
    execWrite(ctx.db, `INSERT INTO event_chain_base (id, seq, hash, pruned, updated_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, pruned = pruned + excluded.pruned, updated_at = excluded.updated_at`,
    last.seq, last.hash, n, now)
    execWrite(ctx.db, 'DELETE FROM event WHERE hash IS NOT NULL AND seq > ? AND seq <= ?', base, last.seq)
    return n
  })
}
