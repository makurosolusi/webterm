/**
 * v26: `project.work_auto_done`, the per-project switch that lets a task whose checks passed go
 * straight to done. Default 0 keeps today's behaviour (a human approves) on every existing project.
 *
 * Idempotent: ALTER ... ADD COLUMN only when the column is missing.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV26(db: Database): void {
  addColumnIfMissing(db, 'project', 'work_auto_done', 'INTEGER NOT NULL DEFAULT 0')
}
