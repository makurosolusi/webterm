/**
 * v25: central work ledger: who was told to do what, since when, and how it is going
 * (docs/decisions/central-orchestrator.md 4A). `event(correlation_id)` serves the per-task timeline.
 *
 * Idempotent and additive (CREATE ... IF NOT EXISTS): no existing table changes, nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V25 = `
CREATE TABLE IF NOT EXISTS central_task (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  objective         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'blocked', 'assigned', 'running', 'waiting_input', 'stalled', 'reported', 'verifying', 'needs_review', 'failed', 'done', 'cancelled')),
  boundaries_json   TEXT CHECK (boundaries_json IS NULL OR json_valid(boundaries_json)),
  acceptance        TEXT NOT NULL DEFAULT 'review' CHECK (acceptance IN ('project_checks', 'review')),
  due_at            INTEGER,
  created_by        TEXT NOT NULL,
  conversation_id   TEXT,
  turn_id           TEXT,
  verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_central_task_project_board ON central_task(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_central_task_board ON central_task(status, updated_at);

CREATE TABLE IF NOT EXISTS central_task_dep (
  task_id       TEXT NOT NULL REFERENCES central_task(id) ON DELETE CASCADE,
  blocked_by_id TEXT NOT NULL REFERENCES central_task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocked_by_id)
);
CREATE INDEX IF NOT EXISTS idx_central_task_dep_blocker ON central_task_dep(blocked_by_id);

CREATE TABLE IF NOT EXISTS central_assignment (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES central_task(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  agent_id        TEXT,
  channel         TEXT NOT NULL CHECK (channel IN ('chat', 'terminal', 'spawn', 'run')),
  instruction     TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  last_signal     TEXT,
  last_signal_at  INTEGER,
  nudged_at       INTEGER,
  restarts        INTEGER NOT NULL DEFAULT 0,
  ended_at        INTEGER,
  end_reason      TEXT,
  result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  conversation_id TEXT,
  turn_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_central_assignment_open_node ON central_assignment(node_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_central_assignment_task ON central_assignment(task_id);

CREATE INDEX IF NOT EXISTS idx_event_correlation ON event(correlation_id);
`

export function applyV25(db: Database): void {
  db.exec(DDL_V25)
}
