/**
 * Deterministic memory consolidation (RND/24 5): content hashing for dedupe and archiving of
 * expired claims. No LLM, no deletion: archived rows stay as `superseded` history.
 */
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { type LedgerContext, allRows, execWrite, tx } from '../ledger/ledgerCore'
import { appendMemoryEvent } from './memoryCore'

/** Archive batch size per sweep; the next sweep takes the rest (Rule 13: bounded work). */
export const ARCHIVE_BATCH = 100
const SYSTEM_ACTOR = 'system:consolidate'

/** sha256 of the whitespace/case-normalised title+body, so trivial rewrites hash the same. */
export function contentHash(title: string, body: string): string {
  const norm = `${title}\n${body}`.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(norm).digest('hex')
}

/**
 * Moves claims past `stale_after` to `superseded` and frees their key (uq_memory_key covers
 * every status). Facts are never touched. Returns how many rows were archived.
 */
export function archiveExpiredClaims(db: Database, now: number): number {
  const ctx: LedgerContext = { db, now: () => now }
  return tx(ctx, () => {
    const rows = allRows(
      db,
      `SELECT id, key FROM memory WHERE status = 'claim' AND superseded_at IS NULL
         AND stale_after IS NOT NULL AND stale_after <= ? ORDER BY stale_after ASC, id ASC LIMIT ?`,
      now, ARCHIVE_BATCH
    )
    for (const row of rows) {
      const id = String(row['id'])
      execWrite(
        db,
        "UPDATE memory SET status = 'superseded', superseded_at = ?, key = ? WHERE id = ? AND status = 'claim'",
        now, `${String(row['key'])}#superseded:${id}`, id
      )
      appendMemoryEvent(ctx, id, SYSTEM_ACTOR, 'memory.archived', { reason: 'expired' }, now)
    }
    return rows.length
  })
}
