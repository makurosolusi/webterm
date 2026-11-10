import type { Database } from 'bun:sqlite'
import { execWrite, getRow } from '../../ledger/ledgerCore'

/** The project's auto-done switch, read fresh on every call; null when the project is unknown. */
export function readAutoDone(db: Database, projectId: string): boolean | null {
  const row = getRow(db, 'SELECT work_auto_done FROM project WHERE id = ?', projectId)
  return row ? Number(row['work_auto_done']) === 1 : null
}

/** Sets the project's auto-done switch; false when the project is unknown. */
export function writeAutoDone(db: Database, projectId: string, autoDone: boolean, at: number): boolean {
  return execWrite(db, 'UPDATE project SET work_auto_done = ?, updated_at = ? WHERE id = ?', autoDone ? 1 : 0, at, projectId) === 1
}
