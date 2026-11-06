// Server-side store of webterm UI sessions (cookie `wt_ui`, auth.ts UI_SESSION_COOKIE). Mirrors
// nodeterm's revocable sessions: only sha256(cookie value) is stored, so a copied webterm.db holds no
// usable credential; a session dies after SESSION_IDLE_MS without a request. Threat model: sec-208-1 /
// sec-208-3 (a sandboxed agent can curl loopback but cannot read the browser profile or the data dir).
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { openDb } from './db'

/** Idle expiry, as nodeterm: a session unused for 30 days is gone. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/** `last_seen` is rewritten at most this often per session, so a busy UI does not write on every request. */
export const SESSION_TOUCH_MS = 60 * 1000
const SESSION_BYTES = 32
/** base64url of SESSION_BYTES; anything else is refused before hashing. */
const SESSION_SHAPE = /^[A-Za-z0-9_-]{43}$/

export interface UiSessionStore {
  /** Mint a session; returns the raw cookie value (never stored). */
  create(): string
  /** true while `raw` names a live session; refreshes its idle clock. */
  verify(raw: string): boolean
  /** Live sessions (expired rows are pruned first). */
  count(): number
  /** Revoke every session except `keep` (the caller's own cookie, when it has one). */
  revokeAllExcept(keep?: string): void
}

const hashOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

/**
 * Migration: `ui_session` is a new table, so `IF NOT EXISTS` on every open is the whole migration:
 * an existing data dir gains an empty table, nothing to backfill, re-running is a no-op.
 */
export function ensureUiSessionSchema(d: Database): void {
  d.exec('CREATE TABLE IF NOT EXISTS ui_session (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);')
}

export function createUiSessionStore(d: Database, now: () => number = Date.now): UiSessionStore {
  ensureUiSessionSchema(d)
  const prune = () => d.query('DELETE FROM ui_session WHERE last_seen < ?').run(now() - SESSION_IDLE_MS)
  return {
    create() {
      prune()
      const raw = randomBytes(SESSION_BYTES).toString('base64url')
      const t = now()
      d.query('INSERT INTO ui_session (hash, created_at, last_seen) VALUES (?, ?, ?)').run(hashOf(raw), t, t)
      return raw
    },
    verify(raw) {
      if (!SESSION_SHAPE.test(raw)) return false
      const hash = hashOf(raw)
      const row = d.query('SELECT last_seen FROM ui_session WHERE hash = ?').get(hash) as { last_seen: number } | null
      if (!row) return false
      const t = now()
      if (t - row.last_seen > SESSION_IDLE_MS) {
        d.query('DELETE FROM ui_session WHERE hash = ?').run(hash)
        return false
      }
      if (t - row.last_seen > SESSION_TOUCH_MS) d.query('UPDATE ui_session SET last_seen = ? WHERE hash = ?').run(t, hash)
      return true
    },
    count() {
      prune()
      return (d.query('SELECT COUNT(*) AS n FROM ui_session').get() as { n: number }).n
    },
    revokeAllExcept(keep) {
      d.query('DELETE FROM ui_session WHERE hash != ?').run(keep && SESSION_SHAPE.test(keep) ? hashOf(keep) : '')
    },
  }
}

let store: UiSessionStore | null = null

/** Production store: a second connection to webterm.db (Db keeps its handle private, as template.runtime.ts). */
export function uiSessions(): UiSessionStore {
  store ??= createUiSessionStore(openDb())
  return store
}
