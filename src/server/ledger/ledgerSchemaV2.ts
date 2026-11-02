/**
 * P3 plan DDL (RND/03-RENCANA.md §8). One versioned plan per project; items carry the
 * task link, file scope, status, and assignee. Idempotent so a partially applied v2
 * from an interrupted build can be completed in place. `version` is the optimistic
 * concurrency token: every plan/plan_item mutation bumps it in the same transaction.
 */
export const DDL_V2 = `
CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES project(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','abandoned')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_item (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','assigned','running','done','failed','cancelled')),
  assignee TEXT, assigned_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE (plan_id, seq)
);

-- Assign-only-before-spawn is enforced in code; this partial index is the last line:
-- one task may back at most one plan item, while pending items keep task_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_item_task ON plan_item(plan_id, task_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_item_plan_status ON plan_item(plan_id, status);
`
