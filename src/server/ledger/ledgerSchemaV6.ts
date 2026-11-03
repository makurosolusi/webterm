/**
 * CA2 v6 `ca2_agents` (RND/29-CA2-ARSITEKTUR-b.md 4.6, 4.8): headless/PTY worker registry and
 * the per-project mailbox. `state` is deliberately unconstrained: the state machine (4.8) is
 * enforced in code so adding a state never needs a migration. `req_id` is the idempotency key.
 */
export const DDL_V6 = `
CREATE TABLE IF NOT EXISTS central_agents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT, kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('worker','reviewer')),
  runner TEXT NOT NULL CHECK (runner IN ('pty','exec')),
  task_id TEXT, fence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('human','orchestrator') OR owner LIKE 'central:%'),
  approval_id TEXT,
  budget_json TEXT CHECK (budget_json IS NULL OR json_valid(budget_json)),
  req_id TEXT UNIQUE, started_at INTEGER NOT NULL, last_event_at INTEGER, ended_at INTEGER, end_reason TEXT
);

CREATE TABLE IF NOT EXISTS agent_mail (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT,
  from_ref TEXT NOT NULL, to_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('msg','ask','reply','done','escalate')),
  body TEXT NOT NULL, req_id TEXT UNIQUE, created_at INTEGER NOT NULL,
  delivered_at INTEGER, acked_at INTEGER, expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_central_agents_project_state ON central_agents(project_id, state);
CREATE INDEX IF NOT EXISTS idx_agent_mail_to_acked ON agent_mail(to_ref, acked_at);
`
