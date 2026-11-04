/**
 * v20 bake-off (PLAN/02-fase.md F6, PLAN/04-buku-ide.md #94/#114): one prompt fanned out to 2-4 headless
 * Claude Code agents, each in its own worktree, compared on a card per candidate before a human picks.
 *
 * - `bakeoff`: the run (repo, base commit, prompt, winner, inbox card) and its lifecycle.
 * - `bakeoff_candidate`: one agent + worktree: outcome, cost, duration and the verifier verdict
 *   (`verdict_json` = the judged summary; sealed evidence never survives JSON, `verified` is the boolean
 *   the server computed from it in-process).
 *
 * Additive and re-run safe (IF NOT EXISTS); new tables, nothing to backfill.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V20 = `
CREATE TABLE IF NOT EXISTS bakeoff (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT,
  repo          TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','ready','picked','merged','cleaned')),
  winner_id     TEXT,
  inbox_item_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bakeoff_created ON bakeoff(created_at);

CREATE TABLE IF NOT EXISTS bakeoff_candidate (
  id           TEXT PRIMARY KEY,
  bakeoff_id   TEXT NOT NULL REFERENCES bakeoff(id),
  idx          INTEGER NOT NULL,
  node_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','done','failed','removed')),
  exit_code    INTEGER,
  error        TEXT,
  cost_micros  INTEGER,
  duration_ms  INTEGER,
  verified     INTEGER NOT NULL DEFAULT 0,
  verdict_json TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  UNIQUE (bakeoff_id, idx)
);
`

export function applyV20(db: Database): void {
  db.exec(DDL_V20)
}
