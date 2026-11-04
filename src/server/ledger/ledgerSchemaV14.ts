/**
 * v14 `inbox_item` (PLAN/02-fase.md F3-a): one row per human-in-the-loop item, the LangChain Agent
 * Inbox model (notify / question / review / gate, github.com/langchain-ai/agent-inbox). A gate is
 * always backed by a ledger `approval` (`approval_id`), so consent keeps its digest/nonce/expiry;
 * this row only carries what the inbox adds: snooze, ignore, edited args, coalescing and push state.
 *
 * - `dedupe_key` UNIQUE: a producer repeating the same news bumps `repeat_count` instead of adding
 *   a row (coalescing); NULL keys never collide.
 * - `approval_id` UNIQUE: each pending approval is mirrored at most once.
 * - `pushed_at`: the Telegram card went out; set once so a restart never re-sends it.
 *
 * Additive only (CREATE ... IF NOT EXISTS): no existing table changes and nothing to backfill, the
 * mirror of already-pending approvals happens lazily at the first inbox read.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V14 = `
CREATE TABLE IF NOT EXISTS inbox_item (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('notify', 'question', 'review', 'gate')),
  source        TEXT NOT NULL,
  project_id    TEXT,
  workspace_id  TEXT,
  node_id       TEXT,
  approval_id   TEXT UNIQUE,
  title         TEXT NOT NULL,
  body          TEXT,
  impact_json   TEXT,
  args_json     TEXT,
  editable      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'ignored')),
  resolution    TEXT,
  resolved_by   TEXT,
  snooze_until  INTEGER,
  dedupe_key    TEXT UNIQUE,
  repeat_count  INTEGER NOT NULL DEFAULT 1,
  pushed_at     INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_item_open ON inbox_item(status, snooze_until, created_at);
`

export function applyV14(db: Database): void {
  db.exec(DDL_V14)
}
