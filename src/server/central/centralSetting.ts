// Named settings in `central_control` (`setting:<name>` rows, v33): configuration that must outlive event
// retention, which prunes the event log but never this table.
import type { Database } from 'bun:sqlite'
import { execWrite, getRow } from '../ledger/ledgerCore'

const scopeOf = (name: string): string => `setting:${name}`

/** The stored value of `name`; undefined when never written (or unreadable JSON). */
export function readCentralSetting(db: Database, name: string): unknown {
  const row = getRow(db, 'SELECT value_json FROM central_control WHERE scope = ?', scopeOf(name))
  if (!row || row['value_json'] === null) return undefined
  try {
    return JSON.parse(String(row['value_json'])) as unknown
  } catch {
    return undefined // a corrupt row reads as "never set"; the next write replaces it
  }
}

/** Upserts `name`; `actor` and `at` are kept as set_by / set_at. */
export function writeCentralSetting(db: Database, name: string, value: unknown, actor: string, at: number): void {
  execWrite(db, `INSERT INTO central_control (scope, set_by, set_at, value_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at, value_json = excluded.value_json, version = version + 1`,
  scopeOf(name), actor, at, JSON.stringify(value))
}
