import type { Database } from 'bun:sqlite'

/**
 * BEGIN IMMEDIATE wrapper (same semantics as ledgerCore.tx) whose scoped handle reports
 * `inTransaction`, so a nested appendEvent joins instead of opening a second BEGIN. Needed
 * because node-env tests run the real code against `node:sqlite`, whose adapter has no
 * `inTransaction` getter; bun:sqlite keeps its own flag. Already inside a transaction = join it.
 */
export function writeTx<T>(db: Database, fn: (txDb: Database) => T): T {
  if ((db as unknown as { inTransaction?: boolean }).inTransaction === true) return fn(db)
  db.exec('BEGIN IMMEDIATE')
  const scoped = {
    inTransaction: true,
    exec: (sql: string) => db.exec(sql),
    query: (sql: string) => db.query(sql),
  } as unknown as Database
  try {
    const result = fn(scoped)
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back; nothing left to undo.
    }
    throw err
  }
}
