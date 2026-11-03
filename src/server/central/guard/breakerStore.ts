// Persistent circuit breaker in `central_breaker` (RND/28b 4.3 #4): opens after BREAKER_THRESHOLD consecutive
// failures with backoff min(30m, 1m*2^n)+jitter, then admits one probe (half_open) once `retry_at` passes.
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { execWrite, getRow, tx } from '../../ledger/ledgerCore'
import type { BreakerDecision, BreakerKey, BreakerPort, BreakerState } from '../contracts/level.types'

/** Consecutive failures that open a closed breaker. */
export const BREAKER_THRESHOLD = 3
export const BREAKER_BASE_MS = 60_000
export const BREAKER_MAX_MS = 30 * 60_000
/** Jitter added to the backoff, as a fraction of it. */
export const BREAKER_JITTER = 0.1
/** A half_open probe that never reports back frees the slot after this long. */
export const BREAKER_PROBE_LEASE_MS = 120_000
const MAX_EXPONENT = 20
const MAX_CODE = 80
/** Audit kind for breaker state changes. */
export const BREAKER_AUDIT_KIND = 'central.breaker'

/** Persisted breaker row. */
export interface BreakerRow { key: string; state: BreakerState; failures: number; openedAt: number | null; retryAt: number | null; lastCode: string | null }

/** Synchronous breaker over SQLite; assignable to the async-agnostic `BreakerPort`. */
export interface SyncBreaker extends BreakerPort {
  allow(key: BreakerKey): BreakerDecision
  trip(key: BreakerKey, code: string): BreakerState
  recordSuccess(key: BreakerKey): void
  /** Forces the breaker open now (doom-loop, operator); counts as one failure at least at threshold. */
  open(key: BreakerKey, code: string): BreakerState
  /** Current row without side effects. */
  peek(key: BreakerKey): BreakerRow | null
}

export function createBreakerStore(deps: { db: Database; now: () => number; random?: () => number }): SyncBreaker {
  const { db, now } = deps
  const random = deps.random ?? Math.random
  const ctx = { db, now }

  const peek = (key: BreakerKey): BreakerRow | null => {
    const r = getRow(db, 'SELECT key, state, failures, opened_at, retry_at, last_code FROM central_breaker WHERE key = ?', key)
    if (!r) return null
    return { key, state: String(r.state) as BreakerState, failures: Number(r.failures), openedAt: r.opened_at === null ? null : Number(r.opened_at), retryAt: r.retry_at === null ? null : Number(r.retry_at), lastCode: r.last_code === null ? null : String(r.last_code) }
  }
  const audit = (key: BreakerKey, from: BreakerState, to: BreakerState, code: string | null): void => {
    if (from !== to) appendEvent(ctx, { actor: 'guard', kind: BREAKER_AUDIT_KIND, payload: { key, from, to, code } })
  }
  const write = (key: BreakerKey, state: BreakerState, failures: number, openedAt: number | null, retryAt: number | null, code: string | null): void => {
    execWrite(db, `INSERT INTO central_breaker (key, state, failures, opened_at, retry_at, last_code) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET state = excluded.state, failures = excluded.failures, opened_at = excluded.opened_at, retry_at = excluded.retry_at, last_code = excluded.last_code`, key, state, failures, openedAt, retryAt, code)
  }
  const backoff = (failures: number): number => {
    const base = Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** Math.min(MAX_EXPONENT, Math.max(0, failures - BREAKER_THRESHOLD)))
    return Math.min(BREAKER_MAX_MS, Math.floor(base * (1 + BREAKER_JITTER * random())))
  }
  const openNow = (key: BreakerKey, from: BreakerState, failures: number, code: string): BreakerState => {
    const at = now()
    write(key, 'open', failures, at, at + backoff(failures), code)
    audit(key, from, 'open', code)
    return 'open'
  }

  return {
    peek,
    allow: (key) => tx(ctx, () => {
      const row = peek(key)
      if (!row || row.state === 'closed') return { allowed: true, state: 'closed' }
      const at = now()
      const retryAt = row.retryAt ?? at
      if (at < retryAt) return { allowed: false, state: row.state, retryAt }
      write(key, 'half_open', row.failures, row.openedAt, at + BREAKER_PROBE_LEASE_MS, row.lastCode)
      audit(key, row.state, 'half_open', row.lastCode)
      return { allowed: true, state: 'half_open' }
    }),
    trip: (key, rawCode) => tx(ctx, () => {
      const code = rawCode.slice(0, MAX_CODE)
      const row = peek(key)
      const failures = (row?.failures ?? 0) + 1
      if (row?.state === 'open') {
        write(key, 'open', failures, row.openedAt, row.retryAt, code)
        return 'open'
      }
      if (row?.state === 'half_open' || failures >= BREAKER_THRESHOLD) return openNow(key, row?.state ?? 'closed', failures, code)
      write(key, 'closed', failures, null, null, code)
      return 'closed'
    }),
    recordSuccess: (key) => tx(ctx, () => {
      const row = peek(key)
      if (!row || (row.state === 'closed' && row.failures === 0)) return
      write(key, 'closed', 0, null, null, null)
      audit(key, row.state, 'closed', null)
    }),
    open: (key, rawCode) => tx(ctx, () => {
      const row = peek(key)
      return openNow(key, row?.state ?? 'closed', Math.max(BREAKER_THRESHOLD, (row?.failures ?? 0) + 1), rawCode.slice(0, MAX_CODE))
    }),
  }
}
