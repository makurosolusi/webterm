// Human accounts for the webterm UI (replace the pasted root token). Rows live in webterm.db next to
// `ui_session`; only an argon2id PHC string (Bun.password) is stored. Password rules follow NIST
// 800-63B: a length floor and a byte cap, no composition rules. Nothing here logs a username or a
// password; callers log the numeric user id only.
import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { openDb } from './db'

// Self-typed slice of Bun.password (no @types/bun, see bun-test.d.ts). Defaults = argon2id.
declare const Bun: {
  password: {
    hash(password: string): Promise<string>
    hashSync(password: string): string
    verify(password: string, hash: string): Promise<boolean>
  }
}

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/
/** NIST 800-63B minimum for a memorized secret chosen by the user (counted in characters). */
export const PASSWORD_MIN = 12
/** Upper bound so a huge body cannot make the hash expensive (argon2 cost grows with input). */
export const PASSWORD_MAX_BYTES = 1024

export interface UiUser { id: number; username: string; createdAt: number; pwChangedAt: number }

export type AuthErrorCode = 'already_setup' | 'invalid_username' | 'username_taken' | 'weak_password' | 'invalid_credentials' | 'not_found'

/** A refused account operation; `code` is stable for the HTTP layer, `message` carries no secret. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string = code) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface UserStore {
  /** Number of accounts (0 = setup not done yet). */
  count(): number
  get(id: number): UiUser | null
  /** The only account when exactly one exists, else null. */
  sole(): UiUser | null
  /** Create the first account; 'already_setup' once any account exists (atomic, race-safe). */
  createOwner(i: { username: string; password: string }): Promise<UiUser>
  /** The user when the pair matches, else null (unknown user costs the same as a wrong password). */
  verifyLogin(username: string, password: string): Promise<UiUser | null>
  changePassword(id: number, current: string, next: string): Promise<void>
  /** Rename after re-checking the password. */
  rename(id: number, username: string, password: string): Promise<UiUser>
  /** Operator reset (CLI only): no current password needed. */
  resetPassword(username: string, next: string): Promise<UiUser>
  /**
   * Synchronous `resetPassword` for the early CLI only: cliGate.ts must exit before index.ts evaluates
   * its next import, and a top-level await would not hold those imports back. Never call from the server.
   */
  resetPasswordSync(username: string, next: string): UiUser
}

interface Row { id: number; username: string; pw_hash: string; created_at: number; pw_changed_at: number }

const toUser = (r: Row): UiUser => ({ id: r.id, username: r.username, createdAt: r.created_at, pwChangedAt: r.pw_changed_at })

/** Migration: new table, so `IF NOT EXISTS` on every open is the whole migration (nothing to backfill). */
export function ensureUiUserSchema(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ui_user (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, pw_changed_at INTEGER NOT NULL);`)
}

function checkUsername(username: string): void {
  if (!USERNAME_RE.test(username)) throw new AuthError('invalid_username', 'username must be 3-32 of A-Z a-z 0-9 . _ -')
}

/** Throws 'weak_password' unless PASSWORD_MIN..PASSWORD_MAX_BYTES. */
export function checkPassword(password: string): void {
  if ([...password].length < PASSWORD_MIN) throw new AuthError('weak_password', `password must be at least ${PASSWORD_MIN} characters`)
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) throw new AuthError('weak_password', `password must be at most ${PASSWORD_MAX_BYTES} bytes`)
}

/** `$argon2id$v=19$m=..,t=..,p=..` of a hash: what decides whether it needs a rehash. */
const paramsOf = (phc: string): string => phc.split('$').slice(0, 4).join('$')

let defaults: Promise<{ params: string; dummy: string }> | null = null
/** Current default PHC params plus a dummy hash for unknown users, computed once per process. */
function hashDefaults(): Promise<{ params: string; dummy: string }> {
  defaults ??= Bun.password.hash(randomBytes(16).toString('hex')).then((dummy) => ({ params: paramsOf(dummy), dummy }))
  return defaults
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE'

export function createUserStore(d: Database, now: () => number = Date.now): UserStore {
  ensureUiUserSchema(d)
  const byId = (id: number) => d.query('SELECT * FROM ui_user WHERE id = ?').get(id) as Row | null
  const byName = (username: string) => d.query('SELECT * FROM ui_user WHERE username = ?').get(username) as Row | null
  const setHash = (id: number, hash: string) => d.query('UPDATE ui_user SET pw_hash = ?, pw_changed_at = ? WHERE id = ?').run(hash, now(), id)

  async function requireMatch(id: number, password: string): Promise<Row> {
    const row = byId(id)
    if (!row) throw new AuthError('not_found', `user ${id} not found`)
    if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES || !(await Bun.password.verify(password, row.pw_hash))) {
      throw new AuthError('invalid_credentials', `wrong password for user ${id}`)
    }
    return row
  }

  function resetRow(username: string, next: string): Row {
    checkPassword(next)
    const row = byName(username)
    if (!row) throw new AuthError('not_found', 'no such user')
    return row
  }

  return {
    count: () => (d.query('SELECT COUNT(*) AS n FROM ui_user').get() as { n: number }).n,
    get(id) {
      const row = byId(id)
      return row ? toUser(row) : null
    },
    sole() {
      const rows = d.query('SELECT * FROM ui_user LIMIT 2').all() as Row[]
      return rows.length === 1 ? toUser(rows[0]) : null
    },
    async createOwner({ username, password }) {
      checkUsername(username)
      checkPassword(password)
      const hash = await Bun.password.hash(password)
      const t = now()
      // One statement decides the race: the second INSERT sees the first row and inserts nothing.
      const r = d.query('INSERT INTO ui_user (username, pw_hash, created_at, pw_changed_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ui_user)')
        .run(username, hash, t, t)
      if (r.changes === 0) throw new AuthError('already_setup', 'an account already exists')
      return toUser(byId(Number(r.lastInsertRowid)) as Row)
    },
    async verifyLogin(username, password) {
      const { params, dummy } = await hashDefaults()
      const row = USERNAME_RE.test(username) ? byName(username) : null
      if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) return null
      const ok = await Bun.password.verify(password, row?.pw_hash ?? dummy)
      if (!row || !ok) return null
      if (paramsOf(row.pw_hash) !== params) {
        // Rehash on login: the only moment the plaintext is available to move an old hash to the new cost.
        d.query('UPDATE ui_user SET pw_hash = ? WHERE id = ?').run(await Bun.password.hash(password), row.id)
      }
      return toUser(row)
    },
    async changePassword(id, current, next) {
      checkPassword(next)
      await requireMatch(id, current)
      setHash(id, await Bun.password.hash(next))
    },
    async rename(id, username, password) {
      checkUsername(username)
      await requireMatch(id, password)
      try {
        d.query('UPDATE ui_user SET username = ? WHERE id = ?').run(username, id)
      } catch (e) {
        if (isUniqueViolation(e)) throw new AuthError('username_taken', `rename of user ${id}: name taken`)
        throw new Error(`rename of user ${id} failed: ${(e as Error).message}`, { cause: e })
      }
      return toUser(byId(id) as Row)
    },
    async resetPassword(username, next) {
      const row = resetRow(username, next)
      setHash(row.id, await Bun.password.hash(next))
      return toUser(byId(row.id) as Row)
    },
    resetPasswordSync(username, next) {
      const row = resetRow(username, next)
      setHash(row.id, Bun.password.hashSync(next))
      return toUser(byId(row.id) as Row)
    },
  }
}

let store: UserStore | null = null

/** Production store: its own connection to webterm.db, as uiSessions(). */
export function uiUsers(): UserStore {
  store ??= createUserStore(openDb())
  return store
}
