// Durable request-idempotency journal for approval mutations. The in-memory `AckStore` in
// `control/controlTypes` resets on restart, so a client that retries the same requestId after a
// crash could mint a second approval/decision. This store persists the acknowledgement in the
// ledger SQLite file instead, with the same TTL and LRU-ish cap as `AckStore`.
//
// No `bun:sqlite` import (value or type): the store is structural, so node-env vitest runtimes and
// fake databases can be detected and skipped by `durableAckFor`.
import type { ApprovalAcks } from '../control/approvalApi'
import { ACK_LIMIT, ACK_TTL_MS } from '../control/controlTypes'

interface AckStatement {
  get(...params: unknown[]): Record<string, unknown> | null
  run(...params: unknown[]): unknown
}

/** Minimal `bun:sqlite` surface (and the nodeSqlite test adapter) this store needs. */
export interface AckDatabase {
  query(sql: string): AckStatement
}

type AckResult = { status: number; body?: unknown }

/** Separator between surface scope and caller key; request route keys never contain NUL. */
const SCOPE_SEP = '\u0000'

/**
 * Ack journal backed by `request_ack`. `expires_at` is absolute epoch-ms, so an ack written before
 * a restart keeps the original 10-minute window rather than restarting it. An optional `scope`
 * namespaces the persisted key so the human and capability surfaces cannot replay each other's
 * response body for a coincidentally equal requestId.
 */
export class DurableAckStore implements ApprovalAcks {
  private readonly prefix: string

  constructor(
    private readonly db: AckDatabase,
    scope?: string
  ) {
    this.prefix = scope === undefined ? '' : `${scope}${SCOPE_SEP}`
  }

  private key(key: string): string {
    return `${this.prefix}${key}`
  }

  get(key: string, now: number): AckResult | undefined {
    const namespaced = this.key(key)
    const row = this.db
      .query('SELECT response_json, expires_at FROM request_ack WHERE key = ?')
      .get(namespaced)
    if (!row) return undefined
    if (now >= Number(row['expires_at'])) {
      this.db.query('DELETE FROM request_ack WHERE key = ?').run(namespaced)
      return undefined
    }
    return JSON.parse(String(row['response_json'])) as AckResult
  }

  set(key: string, result: AckResult, now: number): void {
    // Expired rows are removed first so a re-used key is insertable. Then INSERT OR IGNORE keeps an
    // existing live key's original `expires_at`: a replay must not extend the window.
    this.db.query('DELETE FROM request_ack WHERE expires_at <= ?').run(now)
    this.db
      .query(
        'INSERT OR IGNORE INTO request_ack (key, response_json, created_at, expires_at) VALUES (?, ?, ?, ?)'
      )
      .run(this.key(key), JSON.stringify(result), now, now + ACK_TTL_MS)
    const total = Number(
      this.db.query('SELECT count(*) AS n FROM request_ack').get()?.['n'] ?? 0
    )
    const overflow = total - ACK_LIMIT
    if (overflow <= 0) return
    this.db
      .query(
        'DELETE FROM request_ack WHERE key IN (SELECT key FROM request_ack ORDER BY created_at ASC, rowid ASC LIMIT ?)'
      )
      .run(overflow)
  }
}

const stores = new WeakMap<object, Map<string, DurableAckStore>>()

/**
 * One store per database handle and scope. Returns undefined when `db` has no `query` function,
 * which is how vitest fakes stay on the in-memory `AckStore` without pulling SQLite into those tests.
 */
export function durableAckFor(db: unknown, scope?: string): DurableAckStore | undefined {
  if (typeof db !== 'object' || db === null) return undefined
  if (typeof (db as { query?: unknown }).query !== 'function') return undefined
  const cacheKey = scope ?? ''
  let byScope = stores.get(db)
  if (!byScope) stores.set(db, (byScope = new Map()))
  let store = byScope.get(cacheKey)
  if (!store) byScope.set(cacheKey, (store = new DurableAckStore(db as AckDatabase, scope)))
  return store
}
