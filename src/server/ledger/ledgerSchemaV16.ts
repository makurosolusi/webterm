/**
 * v16 task DAG (PLAN/02-fase.md F4-b), after Orca's orchestration db (`src/main/runtime/orchestration/db.ts`:
 * tasks + dispatch contexts + decision gates). One `dag` per run of work, its `dag_task` nodes with a
 * mandatory structured brief and file lease, one `dag_dispatch` row per worker attempt (escalations and
 * the circuit breaker are bound to it) and `dag_gate` rows for human-only decision gates.
 *
 * - `dag_task.deps_json`: ids of tasks in the same dag; acyclic, checked at creation.
 * - `dag_task.failure_count`: circuit breaker counter (Orca `failDispatch`, 3 strikes -> failed).
 * - `dag_gate.approval_id`: the ledger approval behind the inbox gate card; the scheduler reads its
 *   status, so a decision on the canvas, the inbox or Telegram is the same fact.
 *
 * Additive only (CREATE ... IF NOT EXISTS): no existing table changes, nothing to backfill.
 * v15 is reserved by the routines work package (parallel); versions only need to increase.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V16 = `
CREATE TABLE IF NOT EXISTS dag (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  base_ref     TEXT NOT NULL DEFAULT 'HEAD',
  base_branch  TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'failed', 'cancelled')),
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dag_status ON dag(status, created_at);

CREATE TABLE IF NOT EXISTS dag_task (
  id            TEXT PRIMARY KEY,
  dag_id        TEXT NOT NULL REFERENCES dag(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('work', 'gate')),
  brief_json    TEXT NOT NULL CHECK (json_valid(brief_json)),
  deps_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(deps_json)),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'blocked', 'done', 'failed')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  decision      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (dag_id, key)
);
CREATE INDEX IF NOT EXISTS idx_dag_task_dag ON dag_task(dag_id, status);

CREATE TABLE IF NOT EXISTS dag_dispatch (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES dag_task(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  worktree    TEXT,
  branch      TEXT,
  base_sha    TEXT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'gated', 'abandoned')),
  escalation  TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dag_dispatch_task ON dag_dispatch(task_id, status);

CREATE TABLE IF NOT EXISTS dag_gate (
  id           TEXT PRIMARY KEY,
  dag_id       TEXT NOT NULL REFERENCES dag(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL REFERENCES dag_task(id) ON DELETE CASCADE,
  dispatch_id  TEXT,
  approval_id  TEXT NOT NULL,
  question     TEXT NOT NULL,
  options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by   TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dag_gate_pending ON dag_gate(status, dag_id);
`

export function applyV16(db: Database): void {
  db.exec(DDL_V16)
}
