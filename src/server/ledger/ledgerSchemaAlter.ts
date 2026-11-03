import type { Database } from 'bun:sqlite'

/**
 * Adds `column` to `table` unless it already exists (ALTER ... ADD COLUMN has no IF NOT EXISTS).
 * Returns true when the column was added, so a caller can run a one-time backfill exactly once.
 * `table`/`column`/`definition` come from migration code, never from user input.
 */
export function addColumnIfMissing(db: Database, table: string, column: string, definition: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]
  if (columns.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}
