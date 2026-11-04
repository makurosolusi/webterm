/**
 * v17 cost oracle tables (PLAN/02-fase.md F4-e) + `routine_run.estimate_usd`.
 *
 * Why a version: until v16 the cost module created these tables itself on first use
 * (`costStore.ensureCostSchema`) and the routine store added `estimate_usd` in its constructor, so a
 * schema existed that no migration described (Rule 4 gap). This step makes the ledger own them.
 *
 * - `cost_usage`: one row per billed model response (key = transcript message id), priced at capture.
 * - `cost_run`: one routine run / DAG task as a time window on a node; its cost is the node's usage
 *   inside the window. `produced_diff` feeds the low-ROI pause.
 * - `cost_cap`: per-scope cap (`day`, `routine:<id>`, `dag:<id>`) and pause state.
 * - `routine_run.estimate_usd`: cost-oracle estimate shown next to each run (nullable: older runs
 *   had none, nothing to backfill).
 *
 * Idempotent on installs that already have the module-created tables: every statement is
 * `IF NOT EXISTS` with the same column set the module used, and the ALTER is guarded, so existing
 * rows are kept untouched.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export const DDL_V17 = `
CREATE TABLE IF NOT EXISTS cost_usage (
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
  workspace_id TEXT, node_id TEXT, session_id TEXT, model TEXT,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  cost_micros INTEGER, price_known INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_usage_ts ON cost_usage(ts);
CREATE INDEX IF NOT EXISTS idx_cost_usage_node_ts ON cost_usage(node_id, ts);
CREATE TABLE IF NOT EXISTS cost_run (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('routine','dag')), ref TEXT NOT NULL, label TEXT,
  workspace_id TEXT, node_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  produced_diff INTEGER, cost_micros INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cost_run_ref ON cost_run(kind, ref, ended_at);
CREATE TABLE IF NOT EXISTS cost_cap (
  scope TEXT PRIMARY KEY, limit_micros INTEGER NOT NULL DEFAULT 0, paused_at INTEGER, reason TEXT
);
`

export function applyV17(db: Database): void {
  db.exec(DDL_V17)
  addColumnIfMissing(db, 'routine_run', 'estimate_usd', 'REAL')
}
