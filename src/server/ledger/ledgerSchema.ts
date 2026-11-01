import type { Database } from 'bun:sqlite'

/** One forward-only schema step; `up` runs inside BEGIN IMMEDIATE. */
export interface Migration {
  version: number
  up(db: Database): void
}

/**
 * P2 ledger DDL (RND/03-RENCANA.md §7). Every statement is idempotent so a
 * half-applied schema from an interrupted older build can be completed in
 * place. There is deliberately no FK to `workspace`: the ledger must also open
 * as a standalone file (tests, shadow mode) where that table may not exist.
 * Times are INTEGER epoch-ms; every JSON column is guarded by json_valid().
 */
const V1 = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  branch_base TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 0,
  budget_json TEXT CHECK (budget_json IS NULL OR json_valid(budget_json)),
  lock_epoch INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  name TEXT, role TEXT NOT NULL DEFAULT 'worker',
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 2),
  capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)),
  session_ref TEXT, state TEXT NOT NULL DEFAULT 'idle',
  heartbeat_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  spec TEXT NOT NULL, spec_digest TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','leased','suspect','claimed_done','verified','blocked','failed','cancelled','reopened')),
  fence INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_expires INTEGER, heartbeat_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  idem_key TEXT UNIQUE,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 2),
  provider TEXT, model TEXT, route TEXT, prefix_hash TEXT, tools_hash TEXT,
  outcome TEXT, failure_label TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  versions_json TEXT CHECK (versions_json IS NULL OR json_valid(versions_json)),
  started_at INTEGER NOT NULL, ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES run(id) ON DELETE SET NULL,
  actor TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  question TEXT NOT NULL, choice TEXT, rationale TEXT,
  decided_by TEXT NOT NULL DEFAULT 'human',
  action_digest TEXT, nonce TEXT, scope TEXT, expires_at INTEGER,
  single_use INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT REFERENCES decision(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES decision(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  approved_by TEXT, expires_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  provider_response_id TEXT UNIQUE,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_micros INTEGER, price_known INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prefix (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
  tokens INTEGER, hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'project',
  period TEXT NOT NULL DEFAULT 'total',
  limit_micros INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  hard_cap INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'project', key TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claim' CHECK (status IN ('claim','fact','quarantine','superseded')),
  source_kind TEXT, source_ref TEXT,
  supersedes TEXT REFERENCES memory(id) ON DELETE SET NULL, superseded_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (project_id, scope, key)
);

CREATE TABLE IF NOT EXISTS memory_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json))
);

-- Rebuildable index, never the source of truth: content is served from memory.
-- If rowids ever shift out of band, rebuild with:
--   INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body,
  content='memory', content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE INDEX IF NOT EXISTS idx_task_status_project ON task(status, project_id);
CREATE INDEX IF NOT EXISTS idx_task_lease_expires ON task(lease_expires);
CREATE INDEX IF NOT EXISTS idx_event_run_seq ON event(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_project_started ON run(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_project_updated ON memory(project_id, updated_at);
`

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(V1) }]
