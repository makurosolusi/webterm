import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MIGRATIONS, type Migration } from './ledgerSchema'
import { inTransaction } from './ledgerCore'
import { LedgerError } from './ledgerModel'

type Row = Record<string, unknown>
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}

/** bun:sqlite's ambient types cover only the slice db.ts uses; widen locally. */
function stmt(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}

/** Highest schema version this build knows how to create. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

const BACKUP_KEEP = 3
const MEMORY_DB = ':memory:'

function readUserVersion(db: Database): number {
  const row = stmt(db, 'PRAGMA user_version').get()
  return Number(row?.['user_version'] ?? 0)
}

function writeUserVersion(db: Database, version: number): void {
  // Version comes from code, never from user input, so interpolation is safe.
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`)
}

/**
 * Applies every pending migration up to LATEST_VERSION (or the supplied list),
 * one explicit BEGIN IMMEDIATE transaction each. Returns the resulting version.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = readUserVersion(db)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  // Validate the list before touching the DB: a bad version would otherwise be
  // interpolated into `PRAGMA user_version` after DDL had already run.
  let previous = 0
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new LedgerError(`migration version must be a positive integer, got ${String(m.version)}`)
    }
    if (m.version <= previous) {
      throw new LedgerError(
        `migration versions must be strictly increasing: ${previous} then ${m.version}`
      )
    }
    previous = m.version
  }
  const latest = previous
  if (current > latest) {
    throw new LedgerError(
      `ledger schema is newer than this code: db user_version=${current}, code LATEST_VERSION=${latest}`
    )
  }
  // Track the version actually applied in this run so a duplicated entry cannot
  // slip past the `current` snapshot taken before the loop.
  let applied = current
  for (const m of sorted) {
    if (m.version <= applied) continue
    // db.transaction() is DEFERRED: two writers can both read then deadlock on
    // upgrade, so the lock is taken eagerly and the version bump is in-band.
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db)
      writeUserVersion(db, m.version)
      db.exec('COMMIT')
      applied = m.version
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // SQLite already rolled back (e.g. the exec itself aborted); nothing to undo.
      }
      const cause = err instanceof Error ? err.message : String(err)
      throw new LedgerError(`migration ${m.version} failed: ${cause}`, { cause: err })
    }
  }
  return readUserVersion(db)
}

/** Copies a file DB via VACUUM INTO and verifies the copy; keeps the last 3. */
export function preMigrationBackup(db: Database, path: string): string | null {
  // VACUUM cannot run in a transaction, and SQLite would only say so after the
  // (potentially slow) integrity check. Fail fast with a typed error.
  if (inTransaction(db)) {
    throw new LedgerError('preMigrationBackup: cannot run inside a transaction')
  }
  if (path === MEMORY_DB || path === '') return null
  const check = stmt(db, 'PRAGMA integrity_check').get()
  const verdict = String(check?.['integrity_check'] ?? '')
  if (verdict !== 'ok') {
    throw new LedgerError(`refusing to back up corrupt ledger: integrity_check=${verdict}`)
  }

  const dir = dirname(path)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Always-suffixed sequence keeps same-millisecond backups in creation order
  // under plain lexicographic sort, which is what pruning relies on.
  const name = (n: number) => `${basename(path)}.${stamp}-${String(n).padStart(4, '0')}.v${readUserVersion(db)}.bak`
  let seq = 0
  let target = join(dir, name(seq))
  while (existsSync(target)) {
    seq += 1
    target = join(dir, name(seq))
  }
  // VACUUM INTO writes a compact, fully committed copy; SQL string has no
  // parameter form, so escape the only quote character.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)

  const copy = new Database(target)
  try {
    const copied = String(stmt(copy, 'PRAGMA integrity_check').get()?.['integrity_check'] ?? '')
    if (copied !== 'ok') throw new Error(`backup ${target} failed integrity_check=${copied}`)
  } finally {
    ;(copy as unknown as { close(): void }).close()
  }
  pruneBackups(path)
  return target
}

function pruneBackups(path: string): void {
  const dir = dirname(path)
  const base = basename(path)
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
    .sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    unlinkSync(join(dir, old))
  }
}

/**
 * Opens (creating if needed) a ledger DB with the P2 pragmas applied and the
 * schema migrated. WAL is skipped for in-memory DBs, which have no journal file.
 */
export function openLedgerDb(path: string): Database {
  const db = new Database(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (path !== MEMORY_DB && path !== '') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  return db
}
