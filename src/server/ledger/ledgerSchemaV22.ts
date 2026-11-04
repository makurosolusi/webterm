/**
 * v22: event indexes for time-range reads + `cost_run.kind` accepts 'bakeoff'.
 *
 * - `idx_event_ts (ts, seq)`: replay's workspace scope (`ts >= ? AND ts < ? ... ORDER BY ts, seq`) used
 *   to scan every chained row; `idx_event_node_ts (node_id, ts, seq)`: replay's node scope and the
 *   handoff card's per-node `ts > ?` counts.
 * - `cost_run`: SQLite cannot ALTER a CHECK, so the table is rebuilt once (rows, columns and the
 *   v17 index kept) to admit bake-off candidates as runs, so they count toward cost caps.
 *
 * Idempotent: indexes are IF NOT EXISTS; the rebuild only runs while the stored DDL lacks 'bakeoff'.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V22_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_event_ts ON event(ts, seq);
CREATE INDEX IF NOT EXISTS idx_event_node_ts ON event(node_id, ts, seq);
`

const COST_RUN_V22 = `
CREATE TABLE cost_run_v22 (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('routine','dag','bakeoff')), ref TEXT NOT NULL, label TEXT,
  workspace_id TEXT, node_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  produced_diff INTEGER, cost_micros INTEGER
);
INSERT INTO cost_run_v22 (id, kind, ref, label, workspace_id, node_id, started_at, ended_at, produced_diff, cost_micros)
  SELECT id, kind, ref, label, workspace_id, node_id, started_at, ended_at, produced_diff, cost_micros FROM cost_run;
DROP TABLE cost_run;
ALTER TABLE cost_run_v22 RENAME TO cost_run;
CREATE INDEX IF NOT EXISTS idx_cost_run_ref ON cost_run(kind, ref, ended_at);
`

export function applyV22(db: Database): void {
  db.exec(DDL_V22_INDEXES)
  const ddl = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cost_run'").get() as { sql?: string } | null)?.sql ?? ''
  if (!ddl.includes("'bakeoff'")) db.exec(COST_RUN_V22)
}
