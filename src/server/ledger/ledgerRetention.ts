// Runs the retention registry (ledgerRetention.policy.ts) in bounded batches. Each batch is its own
// short transaction, so a sweep never holds the write lock for long and never loads a table into
// memory. The ledger reaper calls `tick()` every 30 s; a full sweep runs at the first tick (boot),
// then once per RETENTION_INTERVAL_MS — or again on the next tick while a backlog remains.
import { tx, type LedgerContext } from './ledgerCore'
import { RETENTION } from './ledgerRetention.policy'

/** Rows per batch (one transaction). */
export const RETENTION_BATCH = 500
/** Batches per table per sweep; what is left is picked up on the next reaper tick. */
export const RETENTION_MAX_BATCHES = 20
/** Pause between full sweeps once no backlog remains. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000

export interface RetentionReport {
  /** Rows deleted (or compacted) per table, only tables that changed. */
  changed: Record<string, number>
  /** True when some table still had a full batch left at the end (backlog). */
  more: boolean
}

export interface RetentionOptions {
  batch?: number
  maxBatches?: number
}

/** One full pass over the registry. Throws with the table name when a sweep fails. */
export function sweepRetention(ctx: LedgerContext, now: number = ctx.now(), opts: RetentionOptions = {}): RetentionReport {
  const batch = opts.batch ?? RETENTION_BATCH
  const maxBatches = opts.maxBatches ?? RETENTION_MAX_BATCHES
  const report: RetentionReport = { changed: {}, more: false }
  for (const [table, entry] of Object.entries(RETENTION)) {
    if (entry.kind !== 'sweep') continue
    let total = 0
    for (let i = 0; i < maxBatches; i++) {
      let n: number
      try {
        n = tx(ctx, () => entry.sweep(ctx, now, batch))
      } catch (err) {
        throw new Error(`retention sweep ${table} failed`, { cause: err })
      }
      total += n
      if (n < batch) break
      if (i === maxBatches - 1) report.more = true
    }
    if (total > 0) report.changed[table] = total
  }
  return report
}

/** Throttled runner for the reaper: returns the report when a sweep ran, null when it was not due. */
export function createRetention(ctx: LedgerContext, intervalMs = RETENTION_INTERVAL_MS, opts: RetentionOptions = {}) {
  let nextAt = 0
  return {
    sweep: (now?: number): RetentionReport => sweepRetention(ctx, now ?? ctx.now(), opts),
    tick(now: number = ctx.now()): RetentionReport | null {
      if (now < nextAt) return null
      // Set before running: a failing sweep waits a full interval instead of retrying every tick.
      nextAt = now + intervalMs
      const report = sweepRetention(ctx, now, opts)
      if (report.more) nextAt = now
      return report
    },
  }
}

export type Retention = ReturnType<typeof createRetention>
