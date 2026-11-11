/**
 * v30: Central project health (docs/decisions/central-health.md).
 *
 * `central_finding` is one durable row per (project, fingerprint): a rescan refreshes the row instead of piling up
 * duplicates, a dismissed finding keeps its human reason so the same advice is not repeated, and a finding that
 * disappears from a full scan is closed (fixed_at). `task_id` ties review findings to the task whose diff produced
 * them; SET NULL keeps the finding when the task is swept. `central_health_scan` records each run so the once-a-day
 * automatic scan can ask when it last ran and the UI can show what a scan opened and fixed.
 * Additive and idempotent (IF NOT EXISTS); nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V30 = `
CREATE TABLE IF NOT EXISTS central_finding (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('scan', 'review', 'analysis')),
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  file TEXT NOT NULL,
  line INTEGER,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed')),
  task_id TEXT REFERENCES central_task(id) ON DELETE SET NULL,
  dismissed_reason TEXT,
  dismissed_by TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  fixed_at INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_central_finding_project_status ON central_finding(project_id, status, severity);
CREATE TABLE IF NOT EXISTS central_health_scan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('scan', 'review', 'analysis')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  opened INTEGER NOT NULL DEFAULT 0,
  fixed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_central_health_scan_project_started ON central_health_scan(project_id, started_at);
`

export function applyV30(db: Database): void {
  db.exec(DDL_V30)
}
