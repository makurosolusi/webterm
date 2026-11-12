/**
 * v34: `central_playbook_run`, the cursor of a Central playbook (central/playbooks).
 *
 * Why: a playbook chains tools (task.create -> agent.spawn -> agent.prompt). When a step stops on an approval card,
 * the run must survive until a human decides, so the decision hook can continue it from the same step with the ids
 * the earlier steps produced. `call_key` lets a retry of the same call resume instead of starting a second run.
 * Idempotent and additive (CREATE ... IF NOT EXISTS): no existing table changes, nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V34 = `
CREATE TABLE IF NOT EXISTS central_playbook_run (
  id              TEXT PRIMARY KEY,
  playbook        TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  call_key        TEXT NOT NULL,
  params_json     TEXT NOT NULL CHECK (json_valid(params_json)),
  step_index      INTEGER NOT NULL DEFAULT 0,
  saved_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(saved_json)),
  status          TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'done', 'failed', 'rejected', 'expired')),
  approval_id     TEXT,
  code            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbook_run_approval ON central_playbook_run(approval_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_playbook_run_call ON central_playbook_run(call_key, created_at);
CREATE INDEX IF NOT EXISTS idx_playbook_run_updated ON central_playbook_run(updated_at);
`

export function applyV34(db: Database): void {
  db.exec(DDL_V34)
}
