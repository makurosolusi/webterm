// Eval metrics (RND/29-b §4.13) computed straight from `central_turn`: turns/hour, p95 latency,
// error_code ratio, prompt-cache hit ratio and interrupted count. Aggregates only, so every
// number is one bounded query regardless of how many turns the ledger holds.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { INTERRUPTED_CODE } from '../chat/turnReconciler'

const MS_PER_HOUR = 3_600_000
const LATENCY_PERCENTILE = 0.95

/** Half-open window `[sinceMs, untilMs)` on `central_turn.started_at`. */
export interface MetricsWindow {
  sinceMs: number
  untilMs: number
}

export interface CentralMetrics {
  turns: number
  turnsPerHour: number
  /** Nearest-rank p95 of `ended_at - started_at` over finished turns; null when none finished. */
  p95Ms: number | null
  /** Share of all turns per `error_code` (0..1); only codes that occurred. */
  errorCodeRatio: Record<string, number>
  /** cache_read / (cache_read + input) tokens; null when no tokens were recorded. */
  cacheHitRatio: number | null
  interrupted: number
}

const IN_WINDOW = 'started_at >= ? AND started_at < ?'

export const SQL_TURN_COUNT = `SELECT COUNT(*) AS c FROM central_turn WHERE ${IN_WINDOW}`
export const SQL_FINISHED_COUNT =
  `SELECT COUNT(*) AS c FROM central_turn WHERE ${IN_WINDOW} AND ended_at IS NOT NULL`
export const SQL_DURATION_AT_RANK = `SELECT ended_at - started_at AS d FROM central_turn
  WHERE ${IN_WINDOW} AND ended_at IS NOT NULL ORDER BY d ASC, rowid ASC LIMIT 1 OFFSET ?`
export const SQL_ERROR_CODES = `SELECT error_code AS code, COUNT(*) AS c FROM central_turn
  WHERE ${IN_WINDOW} AND error_code IS NOT NULL GROUP BY error_code ORDER BY error_code ASC`
export const SQL_INTERRUPTED = `SELECT COUNT(*) AS c FROM central_turn WHERE ${IN_WINDOW} AND error_code = ?`
export const SQL_CACHE_TOKENS = `SELECT
  COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) AS cache_read,
  COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) AS input
  FROM central_turn WHERE ${IN_WINDOW} AND usage_json IS NOT NULL`

/** Computes all metrics for the window; throws when the window is empty or inverted. */
export function computeMetrics(db: Database, window: MetricsWindow): CentralMetrics {
  const { sinceMs, untilMs } = window
  if (!(untilMs > sinceMs)) throw new Error(`metrics window must have until > since (got ${sinceMs}..${untilMs})`)
  const bounds = [sinceMs, untilMs]
  const turns = Number(getRow(db, SQL_TURN_COUNT, ...bounds)?.['c'] ?? 0)
  const finished = Number(getRow(db, SQL_FINISHED_COUNT, ...bounds)?.['c'] ?? 0)
  const p95Row = finished === 0
    ? null
    : getRow(db, SQL_DURATION_AT_RANK, ...bounds, Math.ceil(LATENCY_PERCENTILE * finished) - 1)
  const errorCodeRatio: Record<string, number> = {}
  for (const row of allRows(db, SQL_ERROR_CODES, ...bounds)) {
    errorCodeRatio[String(row['code'])] = Number(row['c']) / turns
  }
  const cache = getRow(db, SQL_CACHE_TOKENS, ...bounds)
  const cacheRead = Number(cache?.['cache_read'] ?? 0)
  const input = Number(cache?.['input'] ?? 0)
  return {
    turns,
    turnsPerHour: (turns * MS_PER_HOUR) / (untilMs - sinceMs),
    p95Ms: p95Row === null ? null : Number(p95Row['d']),
    errorCodeRatio,
    cacheHitRatio: cacheRead + input === 0 ? null : cacheRead / (cacheRead + input),
    interrupted: Number(getRow(db, SQL_INTERRUPTED, ...bounds, INTERRUPTED_CODE)?.['c'] ?? 0),
  }
}
