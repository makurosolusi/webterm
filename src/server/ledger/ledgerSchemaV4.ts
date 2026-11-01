/**
 * P5 central-agent DDL (RND/08-CENTRAL-AGENT.md D5/D9, RND/13 §2). Additive only:
 * one nullable `project.goal_json` column plus the conversation/message/turn/event
 * tables. No cross-table FKs because the ledger must also open standalone; the
 * central stores validate ownership in code. `central_message.seq` (history) and
 * `central_event.seq` (SSE replay) are independent monotonic sequences.
 */
import type { Database } from 'bun:sqlite'

/**
 * `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS form. The up() guard below makes
 * the column add idempotent; the CHECK keeps goal_json parseable for the goal store.
 */
export const DDL_V4_ADD_GOAL = `
ALTER TABLE project ADD COLUMN goal_json TEXT
  CHECK (goal_json IS NULL OR json_valid(goal_json));
`

/** Idempotent table/index DDL; every statement may be re-run safely. */
export const DDL_V4 = `
CREATE TABLE IF NOT EXISTS central_conversation (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL UNIQUE, project_id TEXT,
  active_turn_id TEXT, last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_message_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS central_message (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('human','assistant','tool','system')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  client_message_id TEXT, turn_id TEXT, state TEXT NOT NULL DEFAULT 'complete', created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, client_message_id));

CREATE TABLE IF NOT EXISTS central_turn (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  status TEXT NOT NULL, runtime TEXT, session_ref TEXT, partial_text TEXT,
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)), error_code TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER);

CREATE TABLE IF NOT EXISTS central_event (
  conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  turn_id TEXT, message_id TEXT, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, seq));

CREATE INDEX IF NOT EXISTS idx_central_message_conversation_seq ON central_message(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_central_turn_conversation_status ON central_turn(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_central_event_conversation_seq ON central_event(conversation_id, seq);
`

/**
 * Applies v4. The column guard covers a re-run after a partially applied migration
 * (SQLite DDL is transactional, but a backup restored mid-version must still work).
 */
export function applyV4(db: Database): void {
  const columns = db.query('PRAGMA table_info(project)').all() as { name?: unknown }[]
  if (!columns.some((column) => column.name === 'goal_json')) db.exec(DDL_V4_ADD_GOAL)
  db.exec(DDL_V4)
}
