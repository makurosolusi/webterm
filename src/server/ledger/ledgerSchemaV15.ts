/**
 * v15 routines (PLAN/02-fase.md F4-a, `src/server/routines/`): saved Schedule / Event / API
 * routines and their run history.
 *
 * - `routine`: the definition as JSON columns (trigger, precheck, action, budget) validated by
 *   `routineModel.parseRoutineInput` at the API boundary; `next_run_at` is the next cron slot.
 * - `routine_run`: one row per run INCLUDING skipped ones with their reason (Claude Code Desktop
 *   scheduled tasks and Orca `skipped_*` statuses keep skips in history). `cost_usd` feeds the
 *   per-day budget cap; `ON DELETE CASCADE` drops the history with its routine.
 *
 * Additive only (CREATE ... IF NOT EXISTS): no existing table changes, nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V15 = `
CREATE TABLE IF NOT EXISTS routine (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  workspace_id  TEXT,
  trigger_json  TEXT NOT NULL,
  precheck_json TEXT,
  action_json   TEXT NOT NULL,
  budget_json   TEXT NOT NULL,
  next_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routine_due ON routine(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS routine_run (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'catch_up', 'event', 'api', 'manual')),
  status         TEXT NOT NULL CHECK (status IN ('running', 'ran', 'skipped', 'failed')),
  reason         TEXT,
  scheduled_for  INTEGER,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  cost_usd       REAL,
  inbox_item_id  TEXT,
  child_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_run_recent ON routine_run(routine_id, started_at);
`

export function applyV15(db: Database): void {
  db.exec(DDL_V15)
}
