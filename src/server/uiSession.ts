// Server-side store of webterm UI sessions (cookie `wt_ui`, auth.ts UI_SESSION_COOKIE). Mirrors
// revocable sessions: only sha256(cookie value) is stored, so a copied webterm.db holds no
// usable credential; a session dies after SESSION_IDLE_MS without a request, or SESSION_ABSOLUTE_MS after
// sign-in whatever its use. A session may name its account (`user_id`, ui_user in uiUser.ts); token-era
// rows have none and stay valid. Threat model: sec-208-1 /
// sec-208-3 (a sandboxed agent can curl loopback but cannot read the browser profile or the data dir).
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { acceptUiSessions } from './approvalAuth'
import { openDb } from './db'

/** Idle expiry: a session unused for 30 days is gone. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Absolute lifetime: a stolen cookie that is kept busy would otherwise live forever on the idle clock
 * alone, so every session is re-authenticated at most this long after it was created (OWASP ASVS 3.3).
 */
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000
/** Stored User-Agent is cut to this many characters (display only, in the session list). */
export const SESSION_UA_MAX = 200
/** Public session id in `list()`: first hex chars of the stored hash (never the cookie value). */
const SESSION_ID_LEN = 12
const SESSION_ID_SHAPE = /^[0-9a-f]{12}$/
/** `last_seen` is rewritten at most this often per session, so a busy UI does not write on every request. */
export const SESSION_TOUCH_MS = 60 * 1000
const SESSION_BYTES = 32
/** base64url of SESSION_BYTES; anything else is refused before hashing. */
const SESSION_SHAPE = /^[A-Za-z0-9_-]{43}$/

export interface UiSessionInfo { id: string; createdAt: number; lastSeen: number; ua: string | null; userId: number | null }

export interface UiSessionStore {
  /** Mint a session (optionally for an account, with the browser's User-Agent); returns the raw cookie value (never stored). */
  create(opts?: { userId?: number; ua?: string }): string
  /** true while `raw` names a live session; refreshes its idle clock. */
  verify(raw: string): boolean
  /** Account of a live session, or null (unknown, expired, or a token-era session without one). */
  userOf(raw: string): number | null
  /** Live sessions, newest first; `id` is the public handle for `revokeById`. */
  list(): UiSessionInfo[]
  /** Revoke the session whose public id is `id`; unknown or malformed ids are a no-op. */
  revokeById(id: string): void
  /** Revoke every session of `userId` except `exceptRaw` (the caller's own cookie). */
  revokeUser(userId: number, exceptRaw?: string): void
  /** Live sessions (expired rows are pruned first). */
  count(): number
  /** Revoke every session except `keep` (the caller's own cookie, when it has one). */
  revokeAllExcept(keep?: string): void
  /** Revoke one session (sign out); unknown or malformed values are a no-op. */
  revoke(raw: string): void
}

const hashOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')

/**
 * Migration: `IF NOT EXISTS` creates the table on a new data dir; `user_id` and `ua` are added behind a
 * PRAGMA guard (SQLite has no ADD COLUMN IF NOT EXISTS). Both are nullable: existing token-era rows
 * need no backfill and keep working. Re-running is a no-op.
 */
export function ensureUiSessionSchema(d: Database): void {
  d.exec('CREATE TABLE IF NOT EXISTS ui_session (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);')
  const cols = new Set((d.query('PRAGMA table_info(ui_session)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('user_id')) d.exec('ALTER TABLE ui_session ADD COLUMN user_id INTEGER')
  if (!cols.has('ua')) d.exec('ALTER TABLE ui_session ADD COLUMN ua TEXT')
}

interface SessionRow { hash: string; created_at: number; last_seen: number; user_id: number | null; ua: string | null }

export function createUiSessionStore(d: Database, now: () => number = Date.now): UiSessionStore {
  ensureUiSessionSchema(d)
  const prune = () => {
    const t = now()
    d.query('DELETE FROM ui_session WHERE last_seen < ? OR created_at < ?').run(t - SESSION_IDLE_MS, t - SESSION_ABSOLUTE_MS)
  }
  /** The live row for `raw` (refreshing its idle clock), else null; an expired row is deleted. */
  function live(raw: string): SessionRow | null {
    if (!SESSION_SHAPE.test(raw)) return null
    const hash = hashOf(raw)
    const row = d.query('SELECT * FROM ui_session WHERE hash = ?').get(hash) as SessionRow | null
    if (!row) return null
    const t = now()
    if (t - row.last_seen > SESSION_IDLE_MS || t - row.created_at > SESSION_ABSOLUTE_MS) {
      d.query('DELETE FROM ui_session WHERE hash = ?').run(hash)
      return null
    }
    if (t - row.last_seen > SESSION_TOUCH_MS) d.query('UPDATE ui_session SET last_seen = ? WHERE hash = ?').run(t, hash)
    return row
  }
  return {
    create(opts = {}) {
      prune()
      const raw = randomBytes(SESSION_BYTES).toString('base64url')
      const t = now()
      d.query('INSERT INTO ui_session (hash, created_at, last_seen, user_id, ua) VALUES (?, ?, ?, ?, ?)')
        .run(hashOf(raw), t, t, opts.userId ?? null, opts.ua ? opts.ua.slice(0, SESSION_UA_MAX) : null)
      return raw
    },
    verify: (raw) => live(raw) !== null,
    userOf: (raw) => live(raw)?.user_id ?? null,
    count() {
      prune()
      return (d.query('SELECT COUNT(*) AS n FROM ui_session').get() as { n: number }).n
    },
    list() {
      prune()
      const rows = d.query('SELECT * FROM ui_session ORDER BY created_at DESC').all() as SessionRow[]
      return rows.map((r) => ({ id: r.hash.slice(0, SESSION_ID_LEN), createdAt: r.created_at, lastSeen: r.last_seen, ua: r.ua, userId: r.user_id }))
    },
    revokeById(id) {
      if (SESSION_ID_SHAPE.test(id)) d.query('DELETE FROM ui_session WHERE substr(hash, 1, ?) = ?').run(SESSION_ID_LEN, id)
    },
    revokeUser(userId, exceptRaw) {
      const keep = exceptRaw && SESSION_SHAPE.test(exceptRaw) ? hashOf(exceptRaw) : ''
      d.query('DELETE FROM ui_session WHERE user_id = ? AND hash != ?').run(userId, keep)
    },
    revokeAllExcept(keep) {
      d.query('DELETE FROM ui_session WHERE hash != ?').run(keep && SESSION_SHAPE.test(keep) ? hashOf(keep) : '')
    },
    revoke(raw) {
      if (SESSION_SHAPE.test(raw)) d.query('DELETE FROM ui_session WHERE hash = ?').run(hashOf(raw))
    },
  }
}

let store: UiSessionStore | null = null

/** Production store: a second connection to webterm.db (Db keeps its handle private, as template.runtime.ts). */
export function uiSessions(): UiSessionStore {
  store ??= createUiSessionStore(openDb())
  return store
}

// The human-only gate (approvalAuth.ts, pure) checks cookies through this registry.
acceptUiSessions((raw) => uiSessions().verify(raw))
