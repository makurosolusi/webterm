/**
 * v24: `cost_run.tier` + `cost_run.model` (model ladder).
 *
 * Why: the ladder picks a tier (T0..T4) and model per run; storing them lets the cost oracle estimate
 * by kind+tier and the UI show what a run cost on which model. Both nullable: rows from before the
 * ladder (and runs left to the CLI default) have none, so there is nothing to backfill.
 *
 * Idempotent: ALTER ... ADD COLUMN only when the column is missing.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV24(db: Database): void {
  addColumnIfMissing(db, 'cost_run', 'tier', 'TEXT')
  addColumnIfMissing(db, 'cost_run', 'model', 'TEXT')
}
